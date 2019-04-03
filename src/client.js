/* eslint no-unused-vars: "off" */
/* global process */

import axios from 'axios';
import uuidv4 from 'uuid/v4';
import { Channel } from './channel';
import { ClientState } from './client_state';
import { StableWSConnection } from './connection';

import { isValidEventType } from './events';

import {
	JWTServerToken,
	JWTUserToken,
	UserFromToken,
	DevToken,
	CheckSignature,
} from './signing';
import http from 'http';
import https from 'https';
import fetch, { Headers } from 'cross-fetch';
import FormData from 'form-data';

function isReadableStream(obj) {
	return (
		typeof obj === 'object' &&
		typeof (obj._read === 'function') &&
		typeof (obj._readableState === 'object')
	);
}

export class StreamChat {
	constructor(key, secretOrOptions, options) {
		// set the key
		this.key = key;
		this.userToken = null;
		this.secret = null;
		this.listeners = {};
		this.state = new ClientState();

		// set the secret
		if (secretOrOptions && secretOrOptions.indexOf) {
			this.secret = secretOrOptions;
		}

		// set the options... and figure out defaults...
		options = options || secretOrOptions;
		if (!options) {
			options = {};
		}

		this.browser =
			typeof options.browser !== 'undefined'
				? options.browser
				: typeof window !== 'undefined';
		this.node = !this.browser;

		const defaultOptions = {
			timeout: 3000,
		};

		if (this.node) {
			const nodeOptions = {
				httpAgent: new http.Agent({ keepAlive: 3000 }),
				httpsAgent: new https.Agent({ keepAlive: 3000 }),
			};
			this.options = { ...nodeOptions, ...defaultOptions, ...options };
		} else {
			this.options = { ...defaultOptions, ...options };
			delete this.options.httpAgent;
			delete this.options.httpsAgent;
		}

		this.setBaseURL('https://chat-us-east-1.stream-io-api.com');

		if (typeof process !== 'undefined' && process.env.STREAM_LOCAL_TEST_RUN) {
			this.setBaseURL('http://localhost:3030');
		}

		// WS connection is initialized when setUser is called
		this.wsConnection = null;
		this.wsPromise = null;
		// keeps a reference to all the channels that are in use
		this.activeChannels = {};
		// mapping between channel groups and configs
		this.configs = {};
		this.anonymous = false;

		this._startCleaning();
	}

	devToken(userID) {
		return DevToken(userID);
	}

	getAuthType() {
		return this.anonymous ? 'anonymous' : 'jwt';
	}

	setBaseURL(baseURL) {
		this.baseURL = baseURL;
		this.wsBaseURL = this.baseURL.replace('http', 'ws');
	}

	_setupConnection() {
		this.UUID = uuidv4();
		this.clientID = `${this.userID}--${this.UUID}`;
		this.connect();
		return this.wsPromise;
	}

	_hasClientID = () => {
		const hasClient = !!this.clientID;
		return hasClient;
	};

	/**
	 * setUser - Set the current user, this triggers a connection to the API
	 *
	 * @param {object} user Data about this user. IE {name: "john"}
	 * @param {string} userToken   Token
	 *
	 * @return {promise} Returns a promise that resolves when the connection is setup
	 */
	setUser(user, userToken) {
		if (this.userID) {
			throw new Error(
				'Use client.disconnect() before trying to connect as a different user. setUser was called twice.',
			);
		}
		// we generate the client id client side
		this.userID = user.id;

		if (!this.userID) {
			throw new Error('The "id" field on the user is missing');
		}

		this.userToken = userToken;

		if (userToken == null && this.secret != null) {
			this.userToken = this.createToken(this.userID);
		}

		if (this.userToken == null) {
			throw new Error('both userToken and api secret are not provided');
		}

		const tokenUserId = UserFromToken(this.userToken);
		if (
			userToken != null &&
			(tokenUserId == null || tokenUserId === '' || tokenUserId !== user.id)
		) {
			throw new Error(
				'userToken does not have a user_id or is not matching with user.id',
			);
		}
		this._setUser(user);
		this.anonymous = false;

		return this._setupConnection();
	}

	_setUser(user) {
		// this one is used by the frontend
		this.user = user;
		// this one is actually used for requests...
		this._user = { ...user };
	}

	/**
	 * updateAppSettings - updates application settings
	 *
	 * @param {object} options App settings.
	 * 		IE: {
	  			"apn_config": {
					"auth_type": "token",
					"auth_key": fs.readFileSync(
						'./apn-push-auth-key.p8',
						'utf-8',
					),
					"key_id": "keyid",
					"team_id": "teamid", //either ALL these 3
					"notification_template": "notification handlebars template",
					"bundle_id": "com.apple.your.app",
					"development": true
				},
				"firebase_config": {
					"server_key": "server key from fcm",
					"notification_template": "notification handlebars template"
				},
				"webhook_url": "https://acme.com/my/awesome/webhook/"
			}
	 */
	async updateAppSettings(options) {
		if (options.apn_config && options.apn_config.p12_cert) {
			options.apn_config.p12_cert = Buffer.from(
				options.apn_config.p12_cert,
			).toString('base64');
		}
		return await this.patch(this.baseURL + '/app', options);
	}

	/**
	 * getAppSettings - retrieves application settings
	 */
	async getAppSettings() {
		return await this.get(this.baseURL + '/app');
	}

	/**
	 * disconnect - closes the WS connection
	 */
	disconnect() {
		// remove the user specific fields
		delete this.user;
		delete this._user;

		delete this.anonymous;
		delete this.userID;
		delete this.userToken;
		this.connectionEstablishedCount = 0;
		// close the WS connection
		if (this.wsConnection) {
			this.wsConnection.disconnect();
		}
	}

	setAnonymousUser() {
		this.anonymous = true;
		this.userID = uuidv4();
		this._setUser({
			id: this.userID,
			anon: true,
		});
		return this._setupConnection();
	}

	/**
	 * setGuestUser - Setup a temporary guest user
	 *
	 * @param {object} user Data about this user. IE {name: "john"}
	 *
	 * @return {promise} Returns a promise that resolves when the connection is setup
	 */
	async setGuestUser(user) {
		let response;
		this.anonymous = true;
		try {
			response = await this.post(this.baseURL + '/guest', { user });
		} catch (e) {
			this.anonymous = false;
			throw e;
		}
		this.anonymous = false;
		const {
			created_at,
			updated_at,
			last_active,
			online,
			...guestUser
		} = response.user;
		return await this.setUser(guestUser, response.access_token);
	}

	/**
	 * createToken - Creates a token to authenticate this user. This function is used server side.
	 * The resulting token should be passed to the client side when the users registers or logs in
	 *
	 * @param {string}   userID         The User ID
	 * @param {string}   exp            The expiration time for the token expressed in the number of seconds since the epoch
	 *
	 * @return {string} Returns a token
	 */
	createToken(userID, exp) {
		const extra = {};
		if (exp != null) {
			extra.exp = exp;
		}
		return JWTUserToken(this.secret, userID, extra, {});
	}

	/**
	 * on - Listen to events on all channels and users your watching
	 *
	 * client.on('message.new', event => {console.log("my new message", event, channel.state.messages)})
	 * or
	 * client.on(event => {console.log(event.type)})
	 *
	 * @param {string} callbackOrString  The event type to listen for (optional)
	 * @param {function} callbackOrNothing The callback to call
	 *
	 * @return {type} Description
	 */
	on(callbackOrString, callbackOrNothing) {
		const key = callbackOrNothing ? callbackOrString : 'all';
		const valid = isValidEventType(key);
		if (!valid) {
			throw Error(`Invalid event type ${key}`);
		}
		const callback = callbackOrNothing ? callbackOrNothing : callbackOrString;
		if (!(key in this.listeners)) {
			this.listeners[key] = [];
		}
		this.listeners[key].push(callback);
	}

	/**
	 * off - Remove the event handler
	 *
	 */
	off(callbackOrString, callbackOrNothing) {
		const key = callbackOrNothing ? callbackOrString : 'all';
		const valid = isValidEventType(key);
		if (!valid) {
			throw Error(`Invalid event type ${key}`);
		}
		const callback = callbackOrNothing ? callbackOrNothing : callbackOrString;
		if (!(key in this.listeners)) {
			this.listeners[key] = [];
		}

		this.listeners[key] = this.listeners[key].filter(value => value !== callback);
	}

	async get(url, params) {
		try {
			const response = await axios.get(url, this._addClientParams(params));
			return this.handleResponse(response);
		} catch (e) {
			if (e.response) {
				return this.handleResponse(e.response);
			} else {
				throw e;
			}
		}
	}

	async put(url, data) {
		let response;
		try {
			response = await axios.put(url, data, this._addClientParams());
			return this.handleResponse(response);
		} catch (e) {
			if (e.response) {
				return this.handleResponse(e.response);
			} else {
				throw e;
			}
		}
	}

	async post(url, data) {
		let response;
		try {
			response = await axios.post(url, data, this._addClientParams());
			return this.handleResponse(response);
		} catch (e) {
			if (e.response) {
				return this.handleResponse(e.response);
			} else {
				throw e;
			}
		}
	}

	async patch(url, data) {
		let response;
		try {
			response = await axios.patch(url, data, this._addClientParams());
			return this.handleResponse(response);
		} catch (e) {
			if (e.response) {
				return this.handleResponse(e.response);
			} else {
				throw e;
			}
		}
	}

	async delete(url, params) {
		let response;
		try {
			response = await axios.delete(url, this._addClientParams(params));
			return this.handleResponse(response);
		} catch (e) {
			if (e.response) {
				return this.handleResponse(e.response);
			} else {
				throw e;
			}
		}
	}

	async sendFile(url, uri, name, contentType, user) {
		const data = new FormData();
		let fileField;

		const params = this._addClientParams();
		if (isReadableStream(uri)) {
			fileField = uri;
		} else {
			fileField = {
				uri,
				name: name || uri.split('/').reverse()[0],
			};
			if (contentType != null) {
				fileField.type = contentType;
			}
		}

		if (user != null) {
			data.append('user', JSON.stringify(user));
		}
		data.append('file', fileField);
		const response = await fetch(`${url}?api_key=${this.key}`, {
			method: 'post',
			body: data,
			headers: new Headers({
				Authorization: params.headers.Authorization,
				'stream-auth-type': this.getAuthType(),
			}),
		});
		response.data = await response.json();
		return this.handleResponse(response);
	}

	errorFromResponse(response) {
		let err;
		err = new Error(`StreamChat error HTTP code: ${response.status}`);
		if (response.data && response.data.code) {
			err = new Error(
				`StreamChat error code ${response.data.code}: ${response.data.message}`,
			);
			err.code = response.data.code;
		}
		err.response = response;
		err.status = response.status;
		return err;
	}

	handleResponse(response) {
		const data = response.data;
		if ((response.status + '')[0] !== '2') {
			throw this.errorFromResponse(response);
		}
		return data;
	}

	dispatchEvent = event => {
		// client event handlers
		this._handleClientEvent(event);

		// channel event handlers
		const cid = event.cid;
		const channel = this.activeChannels[cid];
		if (channel) {
			channel._handleChannelEvent(event);
		}
	};

	handleEvent = messageEvent => {
		// dispatch the event to the channel listeners
		const jsonString = messageEvent.data;
		const event = JSON.parse(jsonString);
		event.received_at = new Date();
		this.dispatchEvent(event);
	};

	_handleClientEvent(event) {
		const client = this;

		// update the client.state with any changes to users
		if (event.type === 'user.presence.changed' || event.type === 'user.updated') {
			client.state.updateUser(event.user);
		}
		if (event.type === 'health.check') {
			if (event.me) {
				client.user = event.me;
				client.state.updateUser(event.me);
			}
		}

		if (event.type === 'notification.message_new') {
			this.configs[event.channel.type] = event.channel.config;
		}

		// gather and call the listeners
		const listeners = [];
		if (client.listeners.all) {
			listeners.push(...client.listeners.all);
		}
		if (client.listeners[event.type]) {
			listeners.push(...client.listeners[event.type]);
		}

		// call the event and send it to the listeners
		for (const listener of listeners) {
			listener(event);
		}
	}

	recoverState = async () => {
		const cids = Object.keys(this.activeChannels || {});
		const lastMessageIDs = {};
		for (const c of Object.values(this.activeChannels)) {
			const lastMessage = c.lastMessage();
			let lastMessageId;
			if (lastMessage) {
				lastMessageId = lastMessage.id;
			}
			lastMessageIDs[c.cid] = lastMessageId;
		}
		if (cids.length) {
			await this.queryChannels(
				{ cid: { $in: cids } },
				{ last_message_at: -1 },
				{ limit: 30, recovery: true, last_message_ids: lastMessageIDs },
			);
			this.dispatchEvent({
				type: 'connection.recovered',
			});
		}
	};

	connect() {
		this.connecting = true;
		const client = this;
		this.failures = 0;

		if (client.userID == null) {
			throw Error(
				'Call setUser or setAnonymousUser before starting the connection',
			);
		}
		const params = {
			client_id: client.clientID,
			user_id: client.userID,
			user_details: client._user,
			user_token: client.userToken,
		};
		const qs = encodeURIComponent(JSON.stringify(params));
		if (qs.length > 1900) {
			throw Error('User object is too large');
		}

		let token = '';

		if (this.anonymous === false) {
			token =
				this.userToken !== null ? this.userToken : JWTServerToken(this.secret);
		}

		const authType = this.getAuthType();
		client.wsURL = `${client.wsBaseURL}/connect?json=${qs}&api_key=${
			this.key
		}&authorization=${token}&stream-auth-type=${authType}`;

		// The StableWSConnection handles all the reconnection logic.
		this.wsConnection = new StableWSConnection({
			wsURL: client.wsURL,
			clientID: this.clientID,
			userID: this.userID,
			recoverCallback: this.recoverState,
			messageCallback: this.handleEvent,
			eventCallback: this.dispatchEvent,
		});

		this.wsPromise = this.wsConnection.connect();

		return this.wsPromise;
	}

	/**
	 * queryUsers - Query users and watch user presence
	 *
	 * @param {object} filterConditions MongoDB style filter conditions
	 * @param {object} sort             Sort options, for instance {last_active: -1}
	 * @param {object} options          Option object, {presence: true}
	 *
	 * @return {object} User Query Response
	 */
	async queryUsers(filterConditions, sort, options) {
		if (!sort) {
			sort = {};
		}
		if (!options) {
			options = {};
		}
		const sortFields = [];
		for (const [k, v] of Object.entries(sort)) {
			sortFields.push({ field: k, direction: v });
		}

		const defaultOptions = {
			presence: true,
		};

		if (!this._hasClientID()) {
			defaultOptions.presence = false;
		}

		// Make sure we wait for the connect promise if there is a pending one
		await Promise.resolve(this.wsPromise);

		// Return a list of users
		const data = await this.get(this.baseURL + '/users', {
			payload: {
				filter_conditions: filterConditions,
				sort: sortFields,
				...defaultOptions,
				...options,
			},
		});

		return data;
	}

	async queryChannels(filterConditions, sort = {}, options = {}) {
		const sortFields = [];

		for (const [k, v] of Object.entries(sort)) {
			sortFields.push({ field: k, direction: v });
		}

		const defaultOptions = {
			state: true,
			watch: true,
			presence: false,
		};

		if (!this._hasClientID()) {
			defaultOptions.watch = false;
		}

		// Return a list of channels
		const payload = {
			filter_conditions: filterConditions,
			sort: sortFields,
			user_details: this._user,
			...defaultOptions,
			...options,
		};

		// Make sure we wait for the connect promise if there is a pending one
		await Promise.resolve(this.wsPromise);

		const data = await this.get(this.baseURL + '/channels', {
			payload,
		});

		const channels = [];

		// update our cache of the configs
		for (const channelState of data.channels) {
			this._addChannelConfig(channelState);
		}

		for (const channelState of data.channels) {
			const c = this.channel(channelState.channel.type, channelState.channel.id);
			c.data = channelState.channel;
			c.initialized = true;
			c._initializeState(channelState);
			channels.push(c);
		}
		return channels;
	}

	async search(filterConditions, query, options = {}) {
		// Return a list of channels
		const payload = {
			filter_conditions: filterConditions,
			query,
			...options,
		};

		// Make sure we wait for the connect promise if there is a pending one
		await Promise.resolve(this.wsPromise);

		const data = await this.get(this.baseURL + '/search', {
			payload,
		});

		return data;
	}

	/**
	 * addDevice - Adds a push device for a user.
	 *
	 * @param {string} id the device id
	 * @param {string} push_provider the push provider (apn or firebase)
	 * @param {string} [userID] the user id (defaults to current user)
	 *
	 */
	async addDevice(id, push_provider, userID = null) {
		return await this.post(this.baseURL + '/devices', {
			id,
			push_provider,
			...(userID != null ? { user_id: userID } : {}),
		});
	}

	/**
	 * getDevices - Returns the devices associated with a current user
	 *
	 * @param {string} [userID] User ID. Only works on serversidex
	 *
	 * @return {devices} Array of devices
	 */
	async getDevices(userID) {
		return await this.get(
			this.baseURL + '/devices',
			userID ? { user_id: userID } : {},
		);
	}

	/**
	 * removeDevice - Removes the device with the given id. Clientside users can only delete their own devices
	 *
	 * @param {string} id The device id
	 * @param {string} [userID] The user id. Only specify this for serverside requests
	 *
	 */
	async removeDevice(id, userID = null) {
		return await this.delete(this.baseURL + '/devices', {
			id,
			...(userID ? { user_id: userID } : {}),
		});
	}

	_addChannelConfig(channelState) {
		this.configs[channelState.channel.type] = channelState.channel.config;
	}

	/**
	 * channel - Returns a new channel with the given type and id
	 *
	 * @param {string} channelType The channel type
	 * @param {string} channelID   The channel data
	 * @param {object} [custom]      Custom data to attach to the channel
	 *
	 * @return {channel} The channel object, initialize it using channel.watch()
	 */
	channel(channelType, channelID, custom = {}) {
		if (!this.userID && !this._isUsingServerAuth()) {
			throw Error('Call setUser or setAnonymousUser before creating a channel');
		}
		if (~channelType.indexOf(':')) {
			throw Error(
				`Invalid channel group ${channelType}, cant contain the : character`,
			);
		}

		if (typeof channelID === 'string') {
			channelID = channelID + '';
			if (~channelID.indexOf(':')) {
				throw Error(
					`Invalid channel id ${channelID}, cant contain the : character`,
				);
			}
		} else {
			// support the 2 param init method
			custom = channelID || {};
			channelID = undefined;
		}

		// there are two ways of solving this,
		// a. only allow 1 channel object per cid
		// b. broadcast events to all channels
		// the first option seems less likely to trip up devs
		let channel;
		if (channelID) {
			const cid = `${channelType}:${channelID}`;
			if (cid in this.activeChannels) {
				channel = this.activeChannels[cid];
				if (Object.keys(custom).length > 0) {
					channel.data = custom;
					channel._data = custom;
				}
			} else {
				channel = new Channel(this, channelType, channelID, custom);
				this.activeChannels[channel.cid] = channel;
			}
		} else {
			channel = new Channel(this, channelType, undefined, custom);
		}

		return channel;
	}

	/**
	 * updateUser - Update or Create the given user object
	 *
	 * @param {object} A user object, the only required field is the user id. IE {id: "myuser"} is valid
	 *
	 * @return {object}
	 */
	async updateUser(userObject) {
		return await this.updateUsers([userObject]);
	}

	/**
	 * updateUsers - Batch update the list of users
	 *
	 * @param {array} A list of users
	 *
	 * @return {object}
	 */
	async updateUsers(users) {
		const userMap = {};
		for (const userObject of users) {
			if (!userObject.id) {
				throw Error('User ID is required when updating a user');
			}
			userMap[userObject.id] = userObject;
		}

		return await this.post(this.baseURL + '/users', {
			users: userMap,
		});
	}

	/** banUser - bans a user from all channels
	 *
	 * @param targetUserID
	 * @param options
	 * @returns {Promise<*>}
	 */
	async banUser(targetUserID, options) {
		return await this.post(this.baseURL + '/moderation/ban', {
			target_user_id: targetUserID,
			...options,
		});
	}

	/** unbanUser - revoke global ban for a user
	 *
	 * @param targetUserID
	 * @returns {Promise<*>}
	 */
	async unbanUser(targetUserID, options) {
		return await this.delete(this.baseURL + '/moderation/ban', {
			target_user_id: targetUserID,
			...options,
		});
	}

	/** muteUser - mutes a user
	 *
	 * @param targetID
	 * @param [userID] Only used with serverside auth
	 * @returns {Promise<*>}
	 */
	async muteUser(targetID, userID = null) {
		return await this.post(this.baseURL + '/moderation/mute', {
			target_id: targetID,
			...(userID ? { user_id: userID } : {}),
		});
	}

	/** unmuteUser - unmutes a user
	 *
	 * @param targetID
	 * @param [userID] Only used with serverside auth
	 * @returns {Promise<*>}
	 */
	async unmuteUser(targetID, userID = null) {
		return await this.post(this.baseURL + '/moderation/unmute', {
			target_id: targetID,
			...(userID ? { user_id: userID } : {}),
		});
	}

	async flagMessage(messageID) {
		return await this.post(this.baseURL + '/moderation/flag', {
			target_message_id: messageID,
		});
	}

	async flagUser(userID) {
		return await this.post(this.baseURL + '/moderation/flag', {
			target_user_id: userID,
		});
	}

	async unflagMessage(messageID) {
		return await this.post(this.baseURL + '/moderation/unflag', {
			target_message_id: messageID,
		});
	}

	async unflagUser(userID) {
		return await this.post(this.baseURL + '/moderation/unflag', {
			target_user_id: userID,
		});
	}

	createChannelType(data) {
		const channelData = Object.assign({}, { commands: ['all'] }, data);
		return this.post(this.baseURL + '/channeltypes', channelData);
	}

	getChannelType(channelType) {
		return this.get(this.baseURL + `/channeltypes/${channelType}`);
	}

	updateChannelType(channelType, data) {
		return this.put(this.baseURL + `/channeltypes/${channelType}`, data);
	}

	deleteChannelType(channelType) {
		return this.delete(this.baseURL + `/channeltypes/${channelType}`);
	}

	listChannelTypes() {
		return this.get(this.baseURL + `/channeltypes`);
	}

	/**
	 * updateMessage - Update the given message
	 *
	 * @param {object} message object, id needs to be specified
	 *
	 * @return {object} Response that includes the message
	 */
	async updateMessage(message, userId) {
		if (!message.id) {
			throw Error('Please specify the message id when calling updateMesssage');
		}

		const clonedMessage = Object.assign({}, message);
		delete clonedMessage.id;

		const reservedMessageFields = [
			'latest_reactions',
			'own_reactions',
			'reply_count',
			'created_at',
			'updated_at',
			'html',
			'command',
			'type',
			'user',
		];

		reservedMessageFields.forEach(function(item) {
			if (clonedMessage[item] != null) {
				delete clonedMessage[item];
			}
		});

		if (userId != null) {
			clonedMessage.user = { id: userId };
		}

		return await this.post(this.baseURL + `/messages/${message.id}`, {
			message: clonedMessage,
		});
	}

	async deleteMessage(messageID) {
		return await this.delete(this.baseURL + `/messages/${messageID}`);
	}

	_userAgent() {
		const description = this.node ? 'node' : 'browser';
		const version = '1.0';
		return `stream-chat-${description}-${version}`;
	}

	/**
	 * _isUsingServerAuth - Returns true if we're using server side auth
	 */
	_isUsingServerAuth = () => {
		// returns if were in server side mode or not...
		const serverAuth = !!this.secret;
		return serverAuth;
	};

	_addClientParams(params = {}) {
		let token = '';
		if (this.secret === null && this.userToken === null && this.anonymous === false) {
			throw new Error(
				'Both secret and user tokens are not set, did you forget to call client.setUser?',
			);
		}

		if (this.anonymous === false) {
			token =
				this.userToken !== null ? this.userToken : JWTServerToken(this.secret);
		}

		return {
			...this.options,
			params: {
				user_id: this.userID,
				...params,
				api_key: this.key,
				client_id: this.clientID,
			},
			headers: { Authorization: token, 'stream-auth-type': this.getAuthType() },
		};
	}

	_startCleaning() {
		const that = this;
		this.cleaningIntervalRef = setInterval(() => {
			// call clean on the channel, used for calling the stop.typing event etc.
			for (const channel of Object.values(that.activeChannels)) {
				channel.clean();
			}
		}, 500);
	}

	verifyWebhook(requestBody, xSignature) {
		return CheckSignature(requestBody, this.secret, xSignature);
	}
}