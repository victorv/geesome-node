/*
 * Copyright ©️ 2018-2021 Galt•Project Society Construction and Terraforming Company
 * (Founded by [Nikolai Popeka](https://github.com/npopeka)
 *
 * Copyright ©️ 2018-2021 Galt•Core Blockchain Company
 * (Founded by [Nikolai Popeka](https://github.com/npopeka) by
 * [Basic Agreement](ipfs/QmaCiXUmSrP16Gz8Jdzq6AJESY1EAANmmwha15uR3c1bsS)).
 */

const { Api, TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { computeCheck } = require("telegram/Password");
const includes = require('lodash/includes');
const pick = require('lodash/pick');
const find = require('lodash/find');
const max = require('lodash/max');
const isNumber = require('lodash/isNumber');
const Sequelize = require("sequelize");

class Telegram {
	models;

	async init(appApi) {
		let sequelize = new Sequelize('geesome-soc-net', 'geesome', 'geesome', {
			'dialect': 'sqlite',
			'storage': 'data/soc-net-database.sqlite'
		});
		this.models = await require("./database")(sequelize);

		appApi.post('/v1/soc-net/telegram/login', async (req, res) => {
			if (!req.user || !req.user.id) {
				return res.send(401);
			}
			res.send(await this.login(req.user.id, req.body), 200);
		});

		appApi.post('/v1/soc-net/telegram/get-user', async (req, res) => {
			if (!req.user || !req.user.id) {
				return res.send(401);
			}
			if (req.body.username === 'me') {
				const client = await this.getClient(req.user.id);
				res.send(await client.getMe(), 200);
			} else {
				return this.getUserInfoByUserId(req.user.id, req.body.username);
			}
		});
	}
	async login(userId, loginData) {
		let { phoneNumber, apiId, apiHash, password, phoneCode, phoneCodeHash } = loginData;
		apiId = parseInt(apiId);

		const acc = await this.models.Account.findOne({where: {userId}});
		const stringSession = new StringSession(acc && acc.sessionKey ? acc.sessionKey : '');
		const client = new TelegramClient(stringSession, apiId, apiHash, {});

		await client.connect();

		if (phoneCodeHash) {
			let res;
			try {
				res = await client.invoke(
					new Api.auth.SignIn({
						phoneNumber,
						phoneCodeHash,
						phoneCode
					}) as any
				);
			} catch (e) {
				if (!includes(e.message, 'SESSION_PASSWORD_NEEDED') || !password) {
					throw e;
				}
				const passwordSrpResult = await client.invoke(new Api['account'].GetPassword({}) as any);
				const passwordSrpCheck = await computeCheck(passwordSrpResult, password);
				res = await client.invoke(
					new Api.auth.CheckPassword({
						password: passwordSrpCheck
					}) as any
				);
			}
			try {
				const sessionKey = client.session.save();
				await this.createOrUpdateAccount({userId, phoneNumber, apiId, apiHash, sessionKey});
			} catch (e) {}
			return res;
		} else {
			const res = await client.sendCode(
				{apiId, apiHash},
				phoneNumber,
			);
			try {
				const sessionKey = client.session.save();
				console.log('sendCode sessionKey', sessionKey);
				await this.createOrUpdateAccount({userId, phoneNumber, sessionKey});
			} catch (e) {}
			return res;
		}
	}
	async createOrUpdateAccount(accData) {
		const userAcc = await this.models.Account.findOne({where: {userId: accData.userId}});
		return userAcc ? userAcc.update(accData) : this.models.Account.create(accData);
	}
	async getClient(userId) {
		let {sessionKey, apiId, apiHash} = await this.models.Account.findOne({where: {userId}});
		apiId = parseInt(apiId);
		const session = new StringSession(sessionKey); // You should put your string session here
		const client = new TelegramClient(session, apiId, apiHash, {});
		await client.connect(); // This assumes you have already authenticated with .start()
		return client;
	}
	async getUserInfoByUserId(userId, userName) {
		const client = await this.getClient(userId);
		return this.getUserInfoByClient(client, userName);
	}
	async getUserInfoByClient(client, userName) {
		return {
			client,
			result: await client.invoke(new Api['users'].GetFullUser({ id: userName }))
		}
	}
	async getChannelInfoByUserId(userId, channelName) {
		const client = await this.getClient(userId);
		return this.getChannelInfoByClient(client, channelName);
	}
	async getChannelInfoByClient(client, channelName) {
		return {
			client,
			result: await client.invoke(
				new Api.channels.GetFullChannel({
					channel: channelName,
				})
			)
		}
	}
	async getMessagesByUserId(userId, channelName, messagesIds) {
		const client = await this.getClient(userId);
		return this.getMessagesByClient(client, channelName, messagesIds);
	}
	async getMessagesByClient(client, channelName, messagesIds) {
		return {
			client,
			result: await client.invoke(new Api.channels.GetMessages({ channel: channelName, id: messagesIds }) as any).then(({messages}) => {
				return messages.map(m => {
					console.log('m', m);
					return pick(m, ['id', 'replyTo', 'date', 'message', 'media', 'action', 'groupedId']);
				}).filter(m => m.date);
			})
		};
	}
	async downloadMediaByUserId(userId, media) {
		return this.downloadMediaByClient(await this.getClient(userId), media)
	}
	async downloadMediaByClient(client, media) {
		let file;
		let fileSize: number;
		let mimeType;
		let thumbSize = 'y';
		if (media.photo || (media.webpage && media.webpage.photo)) {
			file = media.photo || media.webpage.photo;
			const ySize = find(file.sizes, s => s.sizes && s.sizes.length) || {sizes: file.sizes};
			if (isNumber(ySize.sizes[0])) {
				fileSize = max(ySize.sizes);
			} else {
				const maxSize = max(ySize.sizes, s => s.size);
				fileSize = maxSize.size
				thumbSize = maxSize.type;
			}
			mimeType = 'image/jpg';
		} else if (media.document) {
			file = media.document;
			fileSize = file.size;
			mimeType = file.mimeType;
		} else {
			// console.log('media', media);
		}
		console.log('media.webpage', media.webpage);
		return {
			client,
			result: {
				mimeType,
				fileSize,
				content: await client.downloadFile(
					new Api[media.document ? 'InputDocumentFileLocation' : 'InputPhotoFileLocation']({
						id: file.id,
						accessHash: file.accessHash,
						fileReference: file.fileReference,
						thumbSize
					}),
					{
						dcId: file.dcId,
						fileSize,
					}
				),
			}
		};
	}
}

module.exports = Telegram;