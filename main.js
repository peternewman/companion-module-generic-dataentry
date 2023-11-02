const { InstanceBase, Regex, runEntrypoint, InstanceStatus } = require('@companion-module/base')
const UpgradeScripts = require('./upgrades')
const UpdateActions = require('./actions')
const UpdateFeedbacks = require('./feedbacks')
const UpdateVariableDefinitions = require('./variables')
const UpdatePresetDefinitions = require('./presets')
const { format, escape } = require('string-kit')

class DataEntryInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
	}

	/**
	 * Initialization of module
	 * @param {*} config config provided from core
	 */
	async init(config) {
		this.config = config
		this.updateStatus(InstanceStatus.Ok)

		this.modifier = [
			{
				effective: false,
				onetime: false,
				controls: new Set(),
			},
			{
				effective: false,
				onetime: false,
				controls: new Set(),
			},
			{
				effective: false,
				onetime: false,
				controls: new Set(),
			},
		]

		this.timeout = undefined

		this.variables = [
			{ variableId: 'entry_raw', name: 'Current entry', initial: '' },
			{ variableId: 'entry_last', name: 'Last entry', initial: '' },
			{ variableId: 'entry_second_last', name: 'Second last entry', initial: '' },
			{ variableId: 'entry_raw_length', name: 'Length of current entry', initial: 0 },
			{ variableId: 'entry_last_length', name: 'Length of last entry', initial: 0 },
			{ variableId: 'entry_formatted', name: 'Current entry formatted', initial: '' },
			{ variableId: 'entry_cursor', name: 'Current entry with cursor shown', initial: this.config.cursor },
			{ variableId: 'entry_cursor_position', name: 'Position of cursor', initial: 0 },
			{ variableId: 'entrycounter', name: 'Counter of entries', initial: 0 },
		]
		this.updateVariableDefinitions()
		this.initVariables()

		this.updateActions()
		this.updateFeedbacks()
		this.updatePresetDefinitions()
	}

	/**
	 * Cleanup stuff, get's called when module is destroyed
	 */
	async destroy() {
		if (this.timeout) clearTimeout(this.timeout)
		this.log('debug', 'destroy')
	}

	async configUpdated(config) {
		this.cancelTimeout()
		this.config = config
		this.updateActions()
	}

	/**
	 * Sets all variables to their initial values
	 */
	async initVariables() {
		this.variables.forEach((vari) => {
			this[vari.variableId] = vari.initial ?? undefined
		})

		const initObj = {}
		this.setVariableValues(
			this.variables
				.filter((vari) => vari.initial != undefined)
				.reduce((obj, vari) => {
					return {
						...obj,
						[vari.variableId]: vari.initial,
					}
				}, initObj)
		)
	}

	/**
	 * Return config fields for web config
	 */
	getConfigFields() {
		return [
			{
				id: 'autolengthraw',
				label: 'Automatic enter when raw length is reached',
				type: 'checkbox',
				default: false,
				width: 9,
			},
			{
				type: 'number',
				id: 'enterlengthraw',
				label: 'Length',
				width: 3,
				min: 1,
				max: 65536,
				step: 1,
				default: 4,
				isVisible: (conf) => {
					return conf.autolengthraw === true
				},
			},
			{
				id: 'autolengthformatted',
				label: 'Automatic enter when formatted length is reached',
				type: 'checkbox',
				default: false,
				width: 9,
			},
			{
				type: 'number',
				id: 'enterlengthformatted',
				label: 'Length',
				width: 3,
				min: 1,
				max: 65536,
				step: 1,
				default: 4,
				isVisible: (conf) => {
					return conf.autolengthformatted === true
				},
			},
			{
				id: 'autoregex',
				label: 'Automatic enter when regular expression matches',
				type: 'checkbox',
				default: false,
				width: 9,
			},
			{
				id: 'enterregex',
				label: 'Regular expression',
				type: 'textinput',
				width: 12,
				default: '/.*/i',
				regex: '/^/(.+)\\/([gmiyusvd]?)$/',
				isVisible: (conf) => {
					return conf.autoregex === true
				},
			},
			{
				id: 'autotime',
				label: 'Automatic enter after inactivity timeout',
				type: 'checkbox',
				default: false,
				width: 9,
			},
			{
				type: 'number',
				id: 'timeout',
				label: 'Timeout (s)',
				width: 3,
				min: 0.1,
				max: 30,
				step: 0.1,
				default: 2.5,
				isVisible: (conf) => {
					return conf.autotime === true
				},
			},
			{
				type: 'dropdown',
				id: 'criterialogic',
				label: 'Enter Criteria',
				width: 12,
				choices: [
					{ id: 'or', label: 'Any checked criterion is met (OR)' },
					{ id: 'and', label: 'All checked cruteria are met (AND)' },
				],
				default: 'or',
			},
			{
				type: 'dropdown',
				id: 'copydata',
				label: 'When entering...',
				width: 6,
				choices: [
					{ id: 'raw', label: '...copy raw entry' },
					{ id: 'formatted', label: '...copy formatted entry' },
				],
				default: 'raw',
			},
			{
				type: 'dropdown',
				id: 'after',
				label: 'After entering...',
				width: 6,
				choices: [
					{ id: 'clear', label: '...clear raw entry' },
					{ id: 'keep', label: '...keep raw entry' },
				],
				default: 'clear',
			},
			{
				type: 'textinput',
				id: 'format',
				label: 'Format',
				width: 12,
				default: '*',
				useVariables: true,
			},
			{
				type: 'number',
				id: 'maxlength',
				label: 'Maximum entry length before truncation',
				width: 6,
				min: 1,
				max: 65536,
				step: 1,
				default: 1024,
			},
			{
				type: 'textinput',
				id: 'cursor',
				label: 'Cursor Character',
				width: 6,
				default: '|',
				regex: '/^.$/',
			},
		]
	}

	/**
	 * Makes a regular expression from a string
	 * @param {string} string String representating the regular expression including slashes and optional modifiers
	 * @returns {RegExp}
	 */
	buildRegex(string) {
		const parts = string.match(/^\/(.+)\/([gmiyusvd]?)$/)
		if (parts === null) {
			return new RegExp('^\b$') // if input is not a valid regexp, return valid regexp which never matches
		} else {
			try {
				return new RegExp(parts[1], parts[2])
			} catch (error) {
				this.log('error', `Cannot compile regular expression from "${string}", ${error.message}`)
				return new RegExp('^\b$')
			}
		}
	}

	/**
	 * Checks if an automatic enter should be done
	 * @param {*} timer set to truthy value if this check is performed from a timer event
	 * @returns void
	 */
	checkEnter(timer) {
		// with 'or' any configured automation will enter
		if (this.config.criterialogic === 'or') {
			if (
				(this.config.autotime && timer) ||
				(this.config.autolengthraw && this.entry_raw.length >= this.config.enterlengthraw) ||
				(this.config.autolengthformatted && this.entry_formatted.length >= this.config.enterlengthformatted) ||
				(this.config.autoregex && this.buildRegex(this.config.enterregex).test(this.entry_raw))
			) {
				this.enter()
				return
			}
		} else if (this.config.criterialogic === 'and') {
			// with 'and' any configured but unmet automation will abort
			if (this.config.autotime && !timer) {
				return
			}
			if (this.config.autolengthraw && this.entry_raw.length < this.config.enterlengthraw) {
				return
			}
			if (this.config.autolengthformatted && this.entry_formatted.length < this.config.enterlengthformatted) {
				return
			}
			if (this.config.autoregex && !this.buildRegex(this.config.enterregex).test(this.entry_raw)) {
				return
			}
			this.enter()
		}
	}

	/**
	 * Cancels the timeout if there is one
	 */
	cancelTimeout() {
		if (this.timeout) {
			clearTimeout(this.timeout)
			this.timeout = undefined
		}
	}

	/**
	 * Restarts the timer for the timeout
	 */
	restartTimeout() {
		this.cancelTimeout()
		this.timeout = setTimeout(this.fireTimeout.bind(this), this.config.timeout * 1000)
	}

	/**
	 * Gets called when the timeout runs out
	 */
	fireTimeout() {
		this.checkEnter(true)
	}

	/**
	 * Enter data
	 * Handles all variables needed when data is entered
	 * @param {'raw'|'formatted'|undefined} copy  if unset use the copy preference from configuration, if set copy this
	 */
	enter(copy) {
		this.cancelTimeout()
		if (copy === undefined) copy = this.config.copydata
		if (copy === 'raw') {
			this.entry_second_last = this.entry_last
			this.entry_last = this.entry_raw
		} else if (copy === 'formatted') {
			this.entry_second_last = this.entry_last
			this.entry_last = this.entry_formatted
		} else {
			this.log('error', 'copy data unknown: ' + copy)
		}

		this.setVariableValues({
			entry_second_last: this.entry_second_last,
			entry_last: this.entry_last,
		})

		this.entrycounter += 1

		this.setVariableValues({
			entrycounter: this.entrycounter,
		})

		if (copy !== 'none' && this.config.after === 'clear') {
			this.clearRaw()
		}

		this.checkFeedbacks('valid')
	}

	/**
	 * Farmats a string according to preference in configuration and returns the formatted result
	 * @param {string} string the string to format
	 * @returns {string} the formatted string, if format is invalid it returns the original string
	 */
	async formatData(string) {
		let formatstr = await this.parseVariablesInString(this.config.format)
		let formatted = ''
		let formatregex = formatstr.match(/^\/(.+)(?<!\\)\/(.*)\/([gmiyusvd]?)$/)
		if (Array.isArray(formatregex)) {
			try {
				formatted = string.replace(new RegExp(formatregex[1], formatregex[3]), formatregex[2].replaceAll('\\/', '/'))
			} catch (error) {
				formatted = string
				this.log('error', `Regex formatting failed: ${error.message}`)
			}
		} else if (formatstr.match(/%./)) {
			formatted = format(formatstr, string)
		} else if (formatstr === 'shellArg') {
			formatted = escape.shellArg(string)
		} else if (formatstr === 'regExp') {
			formatted = escape.regExp(string)
		} else if (format === 'regExpReplacement') {
			formatted = escape.regExpReplacement(string)
		} else if (formatstr === 'html') {
			formatted = escape.html(string)
		} else if (formatstr === 'htmlAttr') {
			formatted = escape.htmlAttr(string)
		} else if (formatstr === 'htmlSpecialChars') {
			formatted = escape.htmlSpecialChars(string)
		} else if (formatstr === 'control') {
			formatted = escape.control(string)
		} else {
			formatted = string
		}
		return formatted
	}

	/**
	 * Clears the data in entry_raw and updates variables
	 */
	clearRaw() {
		this.entry_raw = ''
		this.entry_cursor = this.config.cursor
		this.entry_cursor_position = 0
		this.entry_raw_length = 0

		this.setVariableValues({
			entry_raw: this.entry_raw,
			entry_cursor: this.entry_cursor,
			entry_cursor_position: this.entry_cursor_position,
			entry_raw_length: this.entry_raw_length,
		})
	}

	/**
	 * Releases a modifier
	 * @param {number} modifier which modifier to release
	 */
	releaseModifier(modifier) {
		this.modifier[modifier].controls.clear()
		this.modifier[modifier].effective = false
		this.modifier[modifier].onetime = false
	}

	/**
	 * Update the action definitions to core
	 */
	updateActions() {
		UpdateActions(this)
	}

	/**
	 * Update the feedback definitions to core
	 */
	updateFeedbacks() {
		UpdateFeedbacks(this)
	}

	/**
	 * Update the variable definitions to core
	 */
	updateVariableDefinitions() {
		UpdateVariableDefinitions(this)
	}

	/**
	 * Update the preset definitions to core
	 */
	updatePresetDefinitions() {
		UpdatePresetDefinitions(this)
	}
}

runEntrypoint(DataEntryInstance, UpgradeScripts)
