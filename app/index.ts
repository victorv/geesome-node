/*
 * Copyright ©️ 2018-2020 Galt•Project Society Construction and Terraforming Company
 * (Founded by [Nikolai Popeka](https://github.com/npopeka)
 *
 * Copyright ©️ 2018-2020 Galt•Core Blockchain Company
 * (Founded by [Nikolai Popeka](https://github.com/npopeka) by
 * [Basic Agreement](ipfs/QmaCiXUmSrP16Gz8Jdzq6AJESY1EAANmmwha15uR3c1bsS)).
 */

import {
  ContentStorageType,
  ContentView,
  CorePermissionName,
  IContent,
  IGeesomeDatabaseModule,
  IListParams,
  IStaticIdHistoryItem,
  IUser,
  IUserLimit,
  UserContentActionName,
  UserLimitName
} from "./modules/database/interface";
import {
  IGeesomeApp, IGeesomeAsyncOperationModule, IGeesomeFileCatalogModule,
  IGeesomeGroupModule,
  IGeesomeInviteModule,
  IUserAccountInput,
  IUserInput,
} from "./interface";
import IGeesomeStorageModule from "./modules/storage/interface";
import {IGeesomeEntityJsonManifestModule} from "./modules/entityJsonManifest/interface";
import IGeesomeDriversModule, {DriverInput, OutputSize} from "./modules/drivers/interface";
import {GeesomeEmitter} from "./events";
import AbstractDriver from "./modules/drivers/abstractDriver";
import IGeesomeCommunicatorModule from "./modules/communicator/interface";
import IGeesomeAccountStorageModule from "./modules/accountStorage/interface";
import IGeesomeApiModule from "./modules/api/interface";

const { BufferListStream } = require('bl');
const commonHelper = require('geesome-libs/src/common');
const ipfsHelper = require('geesome-libs/src/ipfsHelper');
const peerIdHelper = require('geesome-libs/src/peerIdHelper');
const detecterHelper = require('geesome-libs/src/detecter');
const {getDirSize} = require('./modules/drivers/helpers');
let config = require('./config');
let helpers = require('./helpers');
// const appCron = require('./cron');
const appEvents = require('./events') as Function;
// const appListener = require('./listener');
const _ = require('lodash');
const fs = require('fs');
const uuidAPIKey = require('uuid-apikey');
const bcrypt = require('bcrypt');
const mime = require('mime');
const axios = require('axios');
const pIteration = require('p-iteration');
const Transform = require('stream').Transform;
const Readable = require('stream').Readable;
const log = require('debug')('geesome:app');
const saltRounds = 10;

module.exports = async (extendConfig) => {
  config = _.merge(config, extendConfig || {});
  // console.log('config', config);
  const app = new GeesomeApp(config);

  app.config.storageConfig.jsNode.pass = await app.getSecretKey('js-ipfs-pass', 'words');
  app.config.storageConfig.jsNode.salt = await app.getSecretKey('js-ipfs-salt', 'hash');
  
  app.events = appEvents(app);

  // await appCron(app);
  // await appListener(app);

  log('Init modules...');
  app.ms = {} as any;
  await pIteration.forEachSeries(config.modules, async moduleName => {
    log(`Start ${moduleName} module...`);
    try {
      app.ms[moduleName] = await require('./modules/' + moduleName)(app);
    } catch (e) {
      console.error(moduleName + ' module initialization error', e);
    }
  });

  const frontendPath = __dirname + '/../frontend/dist';
  if (fs.existsSync(frontendPath)) {
    const directory = await app.ms.storage.saveDirectory(frontendPath);
    app.frontendStorageId = directory.id;
  }

  return app;
};

class GeesomeApp implements IGeesomeApp {
  events: GeesomeEmitter;

  frontendStorageId;

  ms: {
    database: IGeesomeDatabaseModule,
    drivers: IGeesomeDriversModule,
    api: IGeesomeApiModule,
    asyncOperation: IGeesomeAsyncOperationModule,
    fileCatalog: IGeesomeFileCatalogModule,
    invite: IGeesomeInviteModule,
    group: IGeesomeGroupModule,
    accountStorage: IGeesomeAccountStorageModule,
    communicator: IGeesomeCommunicatorModule,
    storage: IGeesomeStorageModule,
    entityJsonManifest: IGeesomeEntityJsonManifestModule
  };

  constructor(
    public config
  ) {
  }

  checkModules(modulesList: string[]) {
    modulesList.forEach(module => {
      if (!this.ms[module]) {
        throw Error("module_not_defined:" + module);
      }
    });
  }

  async getSecretKey(keyName, mode) {
    const keyPath = `${__dirname}/../data/${keyName}.key`;
    let secretKey;
    try {
      secretKey = fs.readFileSync(keyPath).toString();
      if (secretKey) {
        return secretKey;
      }
    } catch (e) {}
    secretKey = commonHelper.random(mode);
    await new Promise((resolve, reject) => {
      fs.writeFile(keyPath, secretKey, resolve);
    });

    return secretKey;
  }

  /**
   ===========================================
   USERS ACTIONS
   ===========================================
   **/

  async setup(userData) {
    if ((await this.ms.database.getUsersCount()) > 0) {
      throw new Error('already_setup');
    }
    const adminUser = await this.registerUser(userData);

    await pIteration.forEach(['AdminAll', 'UserAll'], (permissionName) => {
      return this.ms.database.addCorePermission(adminUser.id, CorePermissionName[permissionName])
    });

    return {user: adminUser, apiKey: await this.generateUserApiKey(adminUser.id, {type: "password_auth"})};
  }

  async checkNameAndEmail(userId, name, email) {
    userId = parseInt(userId);
    const user = await this.ms.database.getUser(userId);
    if (user && user.name ? false : !name) {
      throw new Error("name_cant_be_null");
    }
    if (email && !helpers.validateEmail(email)) {
      throw new Error("email_invalid");
    }
    if (name && !helpers.validateUsername(name)) {
      throw new Error("forbidden_symbols_in_name");
    } else if (name) {
      const existUserWithName = await this.ms.database.getUserByName(name);
      if (existUserWithName && existUserWithName.id !== userId) {
        throw new Error("username_already_exists");
      }
    }
  }

  async registerUser(userData: IUserInput, joinedByInviteId = null): Promise<any> {
    const {email, name, password} = userData;

    await this.checkNameAndEmail(null, name, email);

    const passwordHash: any = await this.hashPassword(password);

    const storageAccountId = await this.createStorageAccount(name);
    const newUser = await this.ms.database.addUser({
      storageAccountId,
      manifestStaticStorageId: storageAccountId,
      passwordHash,
      name,
      email,
      joinedByInviteId
    });

    if (userData.accounts && userData.accounts.length) {
      await pIteration.forEach(userData.accounts, (userAccount) => {
        return this.setUserAccount(newUser.id, userAccount);
      });
    }

    const manifestStorageId = await this.generateAndSaveManifest('user', newUser);
    await this.bindToStaticId(manifestStorageId, newUser.manifestStaticStorageId);
    await this.ms.database.updateUser(newUser.id, { manifestStorageId });

    if (userData.permissions && userData.permissions.length) {
      await pIteration.forEach(userData.permissions, (permissionName) => {
        return this.ms.database.addCorePermission(newUser.id, permissionName);
      });
    }

    return this.ms.database.getUser(newUser.id);
  }

  async hashPassword(password) {
    return new Promise((resolve, reject) => {
      if (!password) {
        return resolve(null);
      }
      bcrypt.hash(password, saltRounds, async (err, passwordHash) => err ? reject(err) : resolve(passwordHash));
    })
  }

  async comparePasswordWithHash(password, passwordHash) {
    if (!password || !passwordHash) {
      return false;
    }
    return new Promise((resolve, reject) => {
      bcrypt.compare(password, passwordHash, (err, result) => err ? reject(err) : resolve(!!result));
    });
  }

  async loginPassword(usernameOrEmail, password): Promise<any> {
    return this.ms.database.getUserByNameOrEmail(usernameOrEmail).then((user) => {
      if (!user) {
        return null;
      }
      return this.comparePasswordWithHash(password, user.passwordHash).then(success => success ? user : null);
    });
  }

  async updateUser(userId, updateData) {
    //TODO: check apiKey UserAccountManagement permission to updateUser
    const {password, email, name} = updateData;
    await this.checkNameAndEmail(userId, name, email);

    let user = await this.ms.database.getUser(userId);
    let passwordHash: any = user.passwordHash;
    if (password) {
      passwordHash = await this.hashPassword(password);
    }
    const userData = { passwordHash };
    if (name) {
      userData['name'] = name;
    }
    if (email) {
      userData['email'] = email;
    }
    await this.ms.database.updateUser(userId, userData);

    user = await this.ms.database.getUser(userId);
    if (!user.storageAccountId) {
      const storageAccountId = await this.createStorageAccount(user.name);
      await this.ms.database.updateUser(userId, {storageAccountId, manifestStaticStorageId: storageAccountId});
      user = await this.ms.database.getUser(userId);
    }

    const manifestStorageId = await this.generateAndSaveManifest('user', user);
    if (manifestStorageId != user.manifestStorageId) {
      await this.bindToStaticId(manifestStorageId, user.manifestStaticStorageId);
      await this.ms.database.updateUser(userId, {manifestStorageId});
    }

    return this.ms.database.getUser(userId);
  }

  async bindToStaticId(dynamicId, staticId): Promise<IStaticIdHistoryItem> {
    log('bindToStaticId', dynamicId, staticId);
    try {
      await this.ms.communicator.bindToStaticId(dynamicId, staticId);
      log('bindToStaticId:communicator finish');
    } catch (e) {
      log('bindToStaticId:communicator error', e.message);
    }
    // await this.ms.database.destroyStaticIdHistory(staticId);

    return this.ms.database.addStaticIdHistoryItem({
      staticId,
      dynamicId,
      isActive: true,
      boundAt: new Date()
    }).catch(() => null);
  }

  async setUserAccount(userId, accountData: IUserAccountInput) {
    let userAccount;

    if (accountData.id) {
      userAccount = await this.ms.database.getUserAccount(accountData.id);
    } else {
      userAccount = await this.ms.database.getUserAccountByProvider(userId, accountData.provider);
    }

    accountData['userId'] = userId;

    if (userAccount) {
      if (userAccount.userId !== userId) {
        throw new Error("not_permitted");
      }
      return this.ms.database.updateUserAccount(userAccount.id, accountData);
    } else {
      return this.ms.database.createUserAccount(accountData);
    }
  }

  prepareListParams(listParams?: IListParams): IListParams {
    return _.pick(listParams, ['sortBy', 'sortDir', 'limit', 'offset']);
  }

  async checkUserId(userId, createIfNotExist = true) {
    if (userId == 'null' || userId == 'undefined') {
      return null;
    }
    if (!userId || _.isUndefined(userId)) {
      return null;
    }
    if (!commonHelper.isNumber(userId)) {
      let user = await this.getUserByManifestId(userId, userId);
      if (!user && createIfNotExist) {
        user = await this.createUserByRemoteStorageId(userId);
        return user.id;
      } else if (user) {
        userId = user.id;
      }
    }
    return userId;
  }

  async getUserByManifestId(userId, staticId) {
    if (!staticId) {
      const historyItem = await this.ms.database.getStaticIdItemByDynamicId(userId);
      if (historyItem) {
        staticId = historyItem.staticId;
      }
    }
    return this.ms.database.getUserByManifestId(userId, staticId);
  }

  async createUserByRemoteStorageId(manifestStorageId) {
    let staticStorageId;
    if (ipfsHelper.isIpfsHash(manifestStorageId)) {
      staticStorageId = manifestStorageId;
      log('createUserByRemoteStorageId::resolveStaticId', staticStorageId);
      manifestStorageId = await this.resolveStaticId(staticStorageId);
    }

    let dbUser = await this.getUserByManifestId(manifestStorageId, staticStorageId);
    if (dbUser) {
      //TODO: update user if necessary
      return dbUser;
    }
    log('createUserByRemoteStorageId::manifestIdToDbObject', staticStorageId);
    const userObject: IUser = await this.ms.entityJsonManifest.manifestIdToDbObject(staticStorageId || manifestStorageId);
    log('createUserByRemoteStorageId::userObject', userObject);
    userObject.isRemote = true;
    return this.createUserByObject(userObject);
  }

  async createUserByObject(userObject) {
    let dbAvatar = await this.ms.database.getContentByManifestId(userObject.avatarImage.manifestStorageId);
    if (!dbAvatar) {
      dbAvatar = await this.createContentByObject(userObject.avatarImage);
    }
    const userFields = ['manifestStaticStorageId', 'manifestStorageId', 'name', 'title', 'email', 'isRemote', 'description'];
    const dbUser = await this.ms.database.addUser(_.extend(_.pick(userObject, userFields), {
      avatarImageId: dbAvatar ? dbAvatar.id : null
    }));

    if (dbUser.isRemote) {
      this.events.emit(this.events.NewRemoteUser, dbUser);
    }
    return dbUser;
  }

  async generateUserApiKey(userId, data, skipPermissionCheck = false) {
    if (!skipPermissionCheck) {
      await this.checkUserCan(userId, CorePermissionName.UserApiKeyManagement);
    }
    const generated = uuidAPIKey.create();

    data.userId = userId;
    data.valueHash = generated.uuid;

    if (!data.permissions) {
      data.permissions = JSON.stringify(await this.ms.database.getCorePermissions(userId).then(list => list.map(i => i.name)));
    }

    await this.ms.database.addApiKey(data);

    return generated.apiKey;
  }

  async getUserByApiKey(apiKey) {
    if (!apiKey || apiKey === 'null') {
      return null;
    }
    const valueHash = uuidAPIKey.toUUID(apiKey);
    const keyObj = await this.ms.database.getApiKeyByHash(valueHash);
    if (!keyObj) {
      return null;
    }
    return this.ms.database.getUser(keyObj.userId);
  }

  async getUserApiKeys(userId, isDisabled?, search?, listParams?: IListParams) {
    listParams = this.prepareListParams(listParams);
    await this.checkUserCan(userId, CorePermissionName.UserApiKeyManagement);
    return {
      list: await this.ms.database.getApiKeysByUser(userId, isDisabled, search, listParams),
      total: await this.ms.database.getApiKeysCountByUser(userId, isDisabled, search)
    };
  }

  async updateApiKey(userId, apiKeyId, updateData) {
    await this.checkUserCan(userId, CorePermissionName.UserApiKeyManagement);
    const keyObj = await this.ms.database.getApiKey(apiKeyId);

    if (keyObj.userId !== userId) {
      throw new Error("not_permitted");
    }

    delete updateData.id;

    return this.ms.database.updateApiKey(keyObj.id, updateData);
  }

  public async setUserLimit(adminId, limitData: IUserLimit) {
    limitData.adminId = adminId;
    await this.checkUserCan(adminId, CorePermissionName.AdminSetUserLimit);

    const existLimit = await this.ms.database.getUserLimit(limitData.userId, limitData.name);
    if (existLimit) {
      await this.ms.database.updateUserLimit(existLimit.id, limitData);
      return this.ms.database.getUserLimit(limitData.userId, limitData.name);
    } else {
      return this.ms.database.addUserLimit(limitData);
    }
  }

  /**
   ===========================================
   CONTENT ACTIONS
   ===========================================
   **/

  async createContentByObject(contentObject, options: { groupId?, userId?, userApiKeyId? } = {}) {
    const storageId = contentObject.manifestStaticStorageId || contentObject.manifestStorageId;
    let dbContent = await this.ms.database.getContentByStorageId(storageId);
    if (dbContent) {
      return dbContent;
    }
    return this.addContent(contentObject, options);
  }

  async createContentByRemoteStorageId(manifestStorageId, options: { groupId?, userId?, userApiKeyId? } = {}) {
    let dbContent = await this.ms.database.getContentByManifestId(manifestStorageId);
    if (dbContent) {
      return dbContent;
    }
    const contentObject: IContent = await this.ms.entityJsonManifest.manifestIdToDbObject(manifestStorageId);
    contentObject.isRemote = true;
    return this.createContentByObject(contentObject);
  }

  async prepareStorageFileAndGetPreview(storageFile: IStorageFile, extension, fullType) {
    console.log('prepareStorageFileAndGetPreview');
    if (this.isVideoType(fullType)) {
      const videoThumbnailDriver = this.ms.drivers.preview['videoThumbnail'];
      const {storageFile: imageFile, extension: imageExtension, type: imageType, properties} = await this.getContentPreviewStorageFile(storageFile, videoThumbnailDriver, {
        extension,
        getProperties: true
      });

      return {
        storageFile: imageFile,
        extension: imageExtension,
        fullType: imageType,
        properties: _.pick(properties, ['width', 'height'])
      }
    } else {
      return {storageFile, extension, fullType};
    }
  }

  async getPreview(storageFile: IStorageFile, extension, fullType, source?) {
    let storageId = storageFile.id;

    let previewDriverName;
    if (source) {
      if (detecterHelper.isYoutubeUrl(source)) {
        previewDriverName = 'youtubeThumbnail';
      }
    }
    if (!fullType) {
      fullType = '';
    }
    if (!previewDriverName) {
      const splitType = fullType.split('/');
      previewDriverName = this.ms.drivers.preview[splitType[1]] ? splitType[1] : splitType[0];
    }
    if (previewDriverName === 'gif') {
      extension = 'png';
    }
    log('previewDriverName', previewDriverName);
    let previewDriver = this.ms.drivers.preview[previewDriverName] as AbstractDriver;
    if (!previewDriver) {
      return {};
    }

    try {
      if (previewDriver.isInputSupported(DriverInput.Stream)) {
        const {storageFile: mediumFile, type, extension: resultExtension} = await this.getContentPreviewStorageFile(storageFile, previewDriver, {
          extension,
          size: OutputSize.Medium
        });

        let smallFile;
        if (previewDriver.isOutputSizeSupported(OutputSize.Small)) {
          smallFile = await this.getContentPreviewStorageFile(storageFile, previewDriver, {
            extension,
            size: OutputSize.Small
          });
          smallFile = smallFile.storageFile;
        }

        let largeFile;
        if (previewDriver.isOutputSizeSupported(OutputSize.Large)) {
          largeFile = await this.getContentPreviewStorageFile(storageFile, previewDriver, {
            extension,
            size: OutputSize.Large
          });
          largeFile = largeFile.storageFile;
        }

        return {
          smallPreviewStorageId: smallFile ? smallFile.id : null,
          smallPreviewSize: smallFile ? smallFile.size : null,
          largePreviewStorageId: largeFile ? largeFile.id : null,
          largePreviewSize: smallFile ? smallFile.size : null,
          mediumPreviewStorageId: mediumFile.id,
          mediumPreviewSize: mediumFile.size,
          previewMimeType: type,
          previewExtension: resultExtension
        };
      } else if (previewDriver.isInputSupported(DriverInput.Content)) {
        log('preview DriverInput.Content');
        const data = await this.ms.storage.getFileData(storageId);
        log('getFileData');

        const {content: mediumData, type, extension: resultExtension, notChanged: mediumNotChanged} = await previewDriver.processByContent(data, {
          extension,
          size: OutputSize.Medium
        });
        log('processByContent');
        const mediumFile = mediumNotChanged ? storageFile : await this.ms.storage.saveFileByData(mediumData);
        log('mediumFile saveFileByData');

        let smallFile;
        if (previewDriver.isOutputSizeSupported(OutputSize.Small)) {
          const {content: smallData, notChanged: smallNotChanged} = await previewDriver.processByContent(data, {extension, size: OutputSize.Small});
          smallFile = smallNotChanged ? storageFile : await this.ms.storage.saveFileByData(smallData);
        }
        log('smallFile saveFileByData');

        let largeFile;
        if (previewDriver.isOutputSizeSupported(OutputSize.Large)) {
          const {content: largeData, notChanged: largeNotChanged} = await previewDriver.processByContent(data, {extension, size: OutputSize.Large});
          largeFile = largeNotChanged ? storageFile : await this.ms.storage.saveFileByData(largeData);
        }
        log('largeFile saveFileByData');

        return {
          smallPreviewStorageId: smallFile ? smallFile.id : null,
          smallPreviewSize: smallFile ? smallFile.size : null,
          largePreviewStorageId: largeFile ? largeFile.id : null,
          largePreviewSize: smallFile ? smallFile.size : null,
          mediumPreviewStorageId: mediumFile.id,
          mediumPreviewSize: mediumFile.size,
          previewMimeType: type,
          previewExtension: resultExtension
        };
      } else if (previewDriver.isInputSupported(DriverInput.Source)) {
        const {content: resultData, path, extension: resultExtension, type} = await previewDriver.processBySource(source, {});
        let storageFile;
        if (path) {
          storageFile = await this.ms.storage.saveFileByPath(path);
        } else {
          storageFile = await this.ms.storage.saveFileByData(resultData);
        }

        //TODO: other sizes?
        return {
          smallPreviewStorageId: null,
          smallPreviewSize: null,
          largePreviewStorageId: null,
          largePreviewSize: null,
          mediumPreviewStorageId: storageFile.id,
          mediumPreviewSize: storageFile.size,
          previewMimeType: type,
          previewExtension: resultExtension
        };
      }
    } catch (e) {
      console.error('getContentPreviewStorageFile error', e);
      return {};
    }
    throw new Error(previewDriver + "_preview_driver_input_not_found");
  }

  async getContentPreviewStorageFile(storageFile: IStorageFile, previewDriver, options): Promise<any> {
    return new Promise(async (resolve, reject) => {
      if (this.ms.storage.isStreamAddSupport()) {
        const inputStream = await this.ms.storage.getFileStream(storageFile.id);
        options.onError = (err) => {
          reject(err);
        };
        console.log('getContentPreviewStorageFile stream', options);
        const {stream: resultStream, type, extension} = await previewDriver.processByStream(inputStream, options);

        const previewFile = await this.ms.storage.saveFileByData(resultStream);
        console.log('getContentPreviewStorageFile stream storageFile', previewFile);

        let properties;
        if (options.getProperties && this.ms.drivers.metadata[type.split('/')[0]]) {
          const propertiesStream = await this.ms.storage.getFileStream(previewFile.id);
          console.log('getContentPreviewStorageFile stream propertiesStream');
          properties = await this.ms.drivers.metadata[type.split('/')[0]].processByStream(propertiesStream);
        }
        console.log('getContentPreviewStorageFile stream properties', properties);

        return resolve({storageFile: previewFile, type, extension, properties});
      } else {
        if (!storageFile.tempPath) {
          storageFile.tempPath = `/tmp/` + (await commonHelper.random()) + '-' + new Date().getTime() + (options.extension ? '.' + options.extension : '');
          const data = new BufferListStream(await this.ms.storage.getFileData(storageFile.id));
          //TODO: find more efficient way to store content from IPFS to fs
          await new Promise((resolve, reject) => {
            data.pipe(fs.createWriteStream(storageFile.tempPath)).on('close', () => resolve()).on('error', reject);
          })
          storageFile.emitFinish = () => {
            fs.unlinkSync(storageFile.tempPath);
          };
        }
        console.log('fs.existsSync(storageFile.tempPath)', fs.existsSync(storageFile.tempPath));
        console.log('getContentPreviewStorageFile: path', options);
        const {path: previewPath, type, extension} = await previewDriver.processByPathWrapByPath(storageFile.tempPath, options);

        const previewFile = await this.ms.storage.saveFileByPath(previewPath);
        console.log('getContentPreviewStorageFile path storageFile', previewFile);

        let properties;
        if (options.getProperties && this.ms.drivers.metadata[type.split('/')[0]]) {
          console.log('getContentPreviewStorageFile path propertiesStream');
          properties = await this.ms.drivers.metadata[type.split('/')[0]].processByStream(fs.createReadStream(previewPath));
        }
        console.log('getContentPreviewStorageFile path properties', properties);

        fs.unlinkSync(previewPath);

        return resolve({storageFile: previewFile, type, extension, properties});
      }
    });
  }

  async regenerateUserContentPreviews(userId) {
    await this.checkUserCan(userId, CorePermissionName.UserFileCatalogManagement);
    (async () => {
      const previousIpldToNewIpld = [];

      let userContents = [];

      let offset = 0;
      let limit = 100;
      do {
        userContents = await this.ms.database.getContentList(userId, {
          offset,
          limit
        });

        await pIteration.forEach(userContents, async (content: IContent) => {
          const previousIpldToNewIpldItem = [content.manifestStorageId];
          let previewData = await this.getPreview({id: content.storageId, size: content.size}, content.extension, content.mimeType);
          await this.ms.database.updateContent(content.id, previewData);
          const updatedContent = await this.updateContentManifest({
            ...content['toJSON'](),
            ...previewData
          });

          previousIpldToNewIpldItem.push(updatedContent.manifestStorageId);

          previousIpldToNewIpld.push(previousIpldToNewIpldItem);
        });

        offset += limit;
      } while (userContents.length === limit);

      console.log('previousIpldToNewIpld', previousIpldToNewIpld);
      console.log('previousIpldToNewIpld JSON', JSON.stringify(previousIpldToNewIpld));
    })();
  }

  async getApyKeyId(apiKey) {
    const apiKeyDb = await this.ms.database.getApiKeyByHash(uuidAPIKey.toUUID(apiKey));
    if(!apiKeyDb) {
      throw new Error("not_authorized");
    }
    return apiKeyDb.id;
  }

  async saveData(dataToSave, fileName, options: { userId, groupId, view?, driver?, apiKey?, userApiKeyId?, folderId?, mimeType?, path?, onProgress?, waitForPin? }) {
    log('saveData');
    await this.checkUserCan(options.userId, CorePermissionName.UserSaveData);
    log('checkUserCan');
    if (options.path) {
      fileName = this.getFilenameFromPath(options.path);
    }
    const extensionFromName = this.getExtensionFromName(fileName);

    if (options.apiKey && !options.userApiKeyId) {
      const apiKey = await this.ms.database.getApiKeyByHash(uuidAPIKey.toUUID(options.apiKey));
      log('apiKey');
      if(!apiKey) {
        throw new Error("not_authorized");
      }
      options.userApiKeyId = apiKey.id;
    }

    if (dataToSave._bufs) {
      dataToSave = dataToSave._bufs[0];
    }

    if(dataToSave.type === "Buffer") {
      dataToSave = Buffer.from(dataToSave.data)
    }

    if(_.isArray(dataToSave) || _.isTypedArray(dataToSave)) {
      dataToSave = Buffer.from(dataToSave)
    }

    if(_.isNumber(dataToSave)) {
      dataToSave = dataToSave.toString(10);
    }

    let fileStream;
    if(_.isString(dataToSave) || _.isBuffer(dataToSave)) {
      fileStream = new Readable();
      fileStream._read = () => {};
      fileStream.push(dataToSave);
      fileStream.push(null);
    } else {
      fileStream = dataToSave;
    }

    const {resultFile: storageFile, resultMimeType: mimeType, resultExtension: extension, resultProperties} = await this.saveFileByStream(options.userId, fileStream, options.mimeType || mime.lookup(fileName) || extensionFromName, {
      extension: extensionFromName,
      driver: options.driver,
      onProgress: options.onProgress,
      waitForPin: options.waitForPin
    }).catch(e => {
      dataToSave.emit('end');
      dataToSave.destroy && dataToSave.destroy();
      throw e;
    });
    log('saveFileByStream extension', extension, 'mimeType', mimeType);

    let existsContent = await this.ms.database.getContentByStorageAndUserId(storageFile.id, options.userId);
    log('existsContent', !!existsContent);
    if (existsContent) {
      console.log(`Content ${storageFile.id} already exists in database, check preview and folder placement`);
      await this.updateExistsContentMetadata(existsContent, options);
      console.log('isUserCan', options.userId);
      if (await this.isUserCan(options.userId, CorePermissionName.UserFileCatalogManagement)) {
        await this.ms.fileCatalog.addContentToUserFileCatalog(options.userId, existsContent, options);
      }
      return existsContent;
    }

    log('this.addContentWithPreview(storageFile, {resultProperties', resultProperties);
    return this.addContentWithPreview(storageFile, {
      extension,
      mimeType,
      storageType: ContentStorageType.IPFS,
      view: options.view || ContentView.Contents,
      storageId: storageFile.id,
      size: storageFile.size,
      name: fileName,
      propertiesJson: JSON.stringify(resultProperties || {})
    }, options);
  }

  async saveDataByUrl(url, options: { userId, groupId, driver?, apiKey?, userApiKeyId?, folderId?, mimeType?, path?, onProgress? }) {
    await this.checkUserCan(options.userId, CorePermissionName.UserSaveData);
    let name;
    if (options.path) {
      name = this.getFilenameFromPath(options.path);
    } else {
      name = _.last(url.split('/'))
    }
    let extension = this.getExtensionFromName(name);
    let type, properties;

    if (options.apiKey && !options.userApiKeyId) {
      const apiKey = await this.ms.database.getApiKeyByHash(uuidAPIKey.toUUID(options.apiKey));
      if(!apiKey) {
        throw new Error("not_authorized");
      }
      options.userApiKeyId = apiKey.id;
    }

    let storageFile;
    const uploadDriver = options.driver && this.ms.drivers.upload[options.driver] as AbstractDriver;
    if (uploadDriver && uploadDriver.isInputSupported(DriverInput.Source)) {
      const dataToSave = await this.handleSourceByUploadDriver(url, options.driver);
      type = dataToSave.type;
      const {resultFile, resultMimeType, resultExtension, resultProperties} = await this.saveFileByStream(options.userId, dataToSave.stream, type, {
        extension,
        onProgress: options.onProgress
      });
      type = resultMimeType;
      storageFile = resultFile;
      extension = resultExtension;
      properties = resultProperties;
    } else {
      const {resultFile, resultMimeType, resultExtension, resultProperties} = await axios({
        url,
        method: 'get',
        responseType: 'stream'
      }).then((response) => {
        const {status, statusText, data, headers} = response;
        if (status !== 200) {
          throw statusText;
        }
        return this.saveFileByStream(options.userId, data, headers['content-type'] || mime.lookup(name) || extension, {extension, driver: options.driver});
      });
      type = resultMimeType;
      storageFile = resultFile;
      extension = resultExtension;
      properties = resultProperties;
    }

    const existsContent = await this.ms.database.getContentByStorageAndUserId(storageFile.id, options.userId);
    if (existsContent) {
      await this.updateExistsContentMetadata(existsContent, options);
      await this.ms.fileCatalog.addContentToUserFileCatalog(options.userId, existsContent, options);
      return existsContent;
    }

    return this.addContentWithPreview(storageFile, {
      extension,
      storageType: ContentStorageType.IPFS,
      mimeType: type,
      view: ContentView.Attachment,
      storageId: storageFile.id,
      size: storageFile.size,
      name: name,
      propertiesJson: JSON.stringify(properties)
    }, options, url);
  }

  async addContentWithPreview(storageFile: IStorageFile, contentData, options, source?) {
    console.log('addContentWithPreview');
    const {
      storageFile: forPreviewStorageFile,
      extension: forPreviewExtension,
      fullType: forPreviewFullType,
      properties
    } = await this.prepareStorageFileAndGetPreview(storageFile, contentData.extension, contentData.mimeType);
    console.log('getPreview');
    let previewData = await this.getPreview(forPreviewStorageFile, forPreviewExtension, forPreviewFullType, source);

    if (properties) {
      contentData.propertiesJson = JSON.stringify(properties);
    }

    if (storageFile.emitFinish) {
      storageFile.emitFinish();
      storageFile.emitFinish = null;
    }

    return this.addContent({
      ...contentData,
      ...previewData
    }, options);
  }

  async updateExistsContentMetadata(content: IContent, options) {
    const propsToUpdate = ['view'];
    if (content.mediumPreviewStorageId && content.previewMimeType) {
      if (propsToUpdate.some(prop => options[prop] && content[prop] !== options[prop])) {
        await this.ms.database.updateContent(content.id, _.pick(options, propsToUpdate));
        await this.updateContentManifest({
          ...content['toJSON'](),
          ..._.pick(options, propsToUpdate),
        });
      }
      return;
    }
    let updateData = await this.getPreview({id: content.storageId, size: content.size}, content.extension, content.mimeType);
    if(content.userId === options.userId) {
      updateData = {
        ..._.pick(options, propsToUpdate),
        ...updateData,
      }
    }
    await this.ms.database.updateContent(content.id, updateData);
    return this.updateContentManifest({
      ...content['toJSON'](),
      ...updateData,
    });
  }

  getFilenameFromPath(path) {
    return _.trim(path, '/').split('/').slice(-1)[0];
  }

  getExtensionFromName(fileName) {
    return (fileName || '').split('.').length > 1 ? _.last((fileName || '').split('.')).toLowerCase() : null
  }

  isVideoType(fullType) {
    //TODO: detect more video types
    return _.startsWith(fullType, 'video') || _.endsWith(fullType, 'mp4') || _.endsWith(fullType, 'avi') || _.endsWith(fullType, 'mov') || _.endsWith(fullType, 'quicktime');
  }

  async saveDirectoryToStorage(userId, dirPath, options: { groupId?, userId?, userApiKeyId? } = {}) {
    //TODO: refactor block
    let group;
    if (options.groupId) {
      group = await this.ms.database.getGroup(options.groupId)
    }
    options.userId = userId;
    const resultFile = await this.ms.storage.saveDirectory(dirPath);
    return this.addContentWithPreview(resultFile, {
      extension: 'none',
      mimeType: 'directory',
      storageType: ContentStorageType.IPFS,
      view: ContentView.Contents,
      storageId: resultFile.id,
      size: getDirSize(dirPath),
      name: group ? group.name : null,
    }, options);
  }

  private async saveFileByStream(userId, stream, mimeType, options: any = {}): Promise<any> {
    return new Promise(async (resolve, reject) => {
      let extension = (options.extension || _.last(mimeType.split('/')) || '').toLowerCase();

      let properties;
      if (this.isVideoType(mimeType)) {
        log('videoToStreamable processByStream');
        const convertResult = await this.ms.drivers.convert['videoToStreamable'].processByStream(stream, {
          extension: extension,
          onProgress: options.onProgress,
          onError: reject
        });
        stream = convertResult.stream;
        extension = convertResult.extension;
        mimeType = convertResult.type;
        properties =  {duration: convertResult['duration'] };
      }

      const sizeRemained = await this.getUserLimitRemained(userId, UserLimitName.SaveContentSize);

      if (sizeRemained !== null) {
        log('sizeRemained', sizeRemained);
        if(sizeRemained < 0) {
          return reject("limit_reached");
        }
        console.log('sizeRemained', sizeRemained);
        let streamSize = 0;
        const sizeCheckStream = new Transform({
          transform: function (chunk, encoding, callback) {
            streamSize += chunk.length;
            console.log('streamSize', streamSize);
            if (streamSize >= sizeRemained) {
              console.error("limit_reached for user", userId);
              // callback("limit_reached", null);
              reject("limit_reached");
              // stream.emit('error', "limit_reached");
              stream.end();
              sizeCheckStream.end();
            } else {
              callback(false, chunk);
            }
          }
        });
        sizeCheckStream.on('error', reject);

        stream = stream.pipe(sizeCheckStream);
      }
      const storageOptions = {
        waitForPin: options.waitForPin
      };
      log('options.driver', options.driver, 'storageOptions', storageOptions);

      let resultFile: IStorageFile;
      await Promise.all([
        (async () => {
          if (options.driver === 'archive') {
            log('upload archive processByStream');
            const uploadResult = await this.ms.drivers.upload['archive'].processByStream(stream, {
              extension,
              onProgress: options.onProgress,
              onError: reject
            });
            if (!uploadResult) {
              return; // onError handled
            }
            resultFile = await this.ms.storage.saveDirectory(uploadResult['tempPath'], storageOptions);
            if (uploadResult['emitFinish']) {
              uploadResult['emitFinish']();
            }
            mimeType = 'directory';
            extension = 'none';
            console.log('uploadResult', uploadResult);
            resultFile.size = uploadResult['size'];
          } else {
            log('this.ms.storage.isStreamAddSupport()', this.ms.storage.isStreamAddSupport());
            if (this.ms.storage.isStreamAddSupport()) {
              resultFile = await this.ms.storage.saveFileByData(stream, storageOptions);
            } else {
              const uploadResult = await this.ms.drivers.upload['file'].processByStream(stream, {
                extension,
                onProgress: options.onProgress,
                onError: reject
              });
              log('saveDirectory(uploadResult.tempPath)');
              resultFile = await this.ms.storage.saveDirectory(uploadResult['tempPath'], storageOptions);
              resultFile.tempPath = uploadResult['tempPath'];
              resultFile.emitFinish = uploadResult['emitFinish'];
            }
            // get actual size from fileStat. Sometimes resultFile.size is bigger than fileStat size
            // log('getFileStat', resultFile, 'resultFile');
            const storageContentStat = await this.ms.storage.getFileStat(resultFile.id);
            log('storageContentStat', storageContentStat);
            resultFile.size = storageContentStat.size;
            log('resultFile.size', resultFile.size);
          }
        })(),

        (async () => {
          console.log('mimeType', mimeType);
          if (_.startsWith(mimeType, 'image')) {
            properties = await this.ms.drivers.metadata['image'].processByStream(stream);
            console.log('metadata processByStream', properties);
          }
        })()
      ]);

      resolve({
        resultFile: resultFile,
        resultMimeType: mimeType,
        resultExtension: extension,
        resultProperties: properties
      });
    });
  }

  async getUserLimitRemained(userId, limitName: UserLimitName) {
    const limit = await this.ms.database.getUserLimit(userId, limitName);
    if (!limit || !limit.isActive) {
      return null;
    }
    if (limitName === UserLimitName.SaveContentSize) {
      const uploadSize = await this.ms.database.getUserContentActionsSizeSum(userId, UserContentActionName.Upload, limit.periodTimestamp);
      const pinSize = await this.ms.database.getUserContentActionsSizeSum(userId, UserContentActionName.Pin, limit.periodTimestamp);
      console.log('uploadSize', uploadSize, 'pinSize', pinSize, 'limit.value', limit.value );
      return limit.value - uploadSize - pinSize;
    } else {
      throw new Error("Unknown limit");
    }
  }

  private async addContent(contentData: IContent, options: { groupId?, userId?, userApiKeyId? } = {}) {
    log('addContent');
    //TODO: refactor block
    if (options.groupId) {
      const groupId = await this.ms.group.checkGroupId(options.groupId);
      let group;
      if (groupId) {
        contentData.groupId = groupId;
        group = await this.ms.database.getGroup(groupId);
      }
      contentData.isPublic = group && group.isPublic;
    }

    if(!contentData.size) {
      const storageContentStat = await this.ms.storage.getFileStat(contentData.storageId);
      log('storageContentStat');

      contentData.size = storageContentStat.size;
    }

    if(!contentData.userId && options.userId) {
      contentData.userId = options.userId;
    }

    const content = await this.ms.database.addContent(contentData);
    log('content');

    const promises = [];
    promises.push((async () => {
      if (content.userId && await this.isUserCan(content.userId, CorePermissionName.UserFileCatalogManagement)) {
        log('isUserCan');
        await this.ms.fileCatalog.addContentToUserFileCatalog(content.userId, content, options);
        log('addContentToUserFileCatalog');
      }
    })());

    promises.push(this.ms.database.addUserContentAction({
      name: UserContentActionName.Upload,
      userId: content.userId,
      size: content.size,
      contentId: content.id,
      userApiKeyId: options.userApiKeyId
    }));
    log('addUserContentAction');

    if (!contentData.manifestStorageId) {
      log('updateContentManifest');
      promises.push(this.updateContentManifest(content));
      return _.last(await Promise.all(promises));
    } else {
      return content;
    }
  }

  async handleSourceByUploadDriver(sourceLink, driver) {
    const uploadDriver = this.ms.drivers.upload[driver] as AbstractDriver;
    if (!uploadDriver) {
      throw new Error(driver + "_upload_driver_not_found");
    }
    if (!_.includes(uploadDriver.supportedInputs, DriverInput.Source)) {
      throw new Error(driver + "_upload_driver_input_not_correct");
    }
    return uploadDriver.processBySource(sourceLink, {});
  }

  /**
   ===========================================
   ETC ACTIONS
   ===========================================
   **/

  async updateContentManifest(content) {
    content.description = content.description || '';
    const manifestStorageId = await this.generateAndSaveManifest('content', content);
    content.manifestStorageId = manifestStorageId;
    await this.ms.database.updateContent(content.id, {manifestStorageId});
    return content;
  }

  async generateAndSaveManifest(entityName, entityObj) {
    const manifestContent = await this.ms.entityJsonManifest.generateContent(entityName + '-manifest', entityObj);
    const hash = await this.saveDataStructure(manifestContent, {waitForStorage: true});
    console.log(entityName, hash, JSON.stringify(manifestContent.posts ? {...manifestContent, posts: ['hidden']} : manifestContent, null, ' '));
    return hash;
  }

  getFileStream(filePath, options = {}) {
    return this.ms.storage.getFileStream(filePath, options)
  }

  getContent(contentId) {
    return this.ms.database.getContent(contentId);
  }

  getContentByStorageId(storageId) {
    return this.ms.database.getContentByStorageId(storageId);
  }

  getContentByManifestId(storageId) {
    return this.ms.database.getContentByManifestId(storageId);
  }

  async getDataStructure(storageId, isResolve = true) {
    const dataPathSplit = storageId.split('/');
    if (ipfsHelper.isIpfsHash(dataPathSplit[0])) {
      try {
        const dynamicIdByStaticId = await this.resolveStaticId(dataPathSplit[0]);
        if (dynamicIdByStaticId) {
          dataPathSplit[0] = dynamicIdByStaticId;
          storageId = dataPathSplit.join('/');
        }
      } catch (e) {}
    }

    const isPath = dataPathSplit.length > 1;
    const resolveProp = isPath ? isResolve : false;

    const dbObject = await this.ms.database.getObjectByStorageId(storageId, resolveProp);
    if (dbObject) {
      const { data } = dbObject;
      return _.startsWith(data, '{') || _.startsWith(data, '[') ? JSON.parse(data) : data;
    }
    return this.ms.storage.getObject(storageId, resolveProp).then((result) => {
      this.ms.database.addObject({storageId, data: _.isString(result) ? result : JSON.stringify(result)}).catch(() => {/* already saved */});
      return result;
    }).catch(e => {
      console.error('getObject error', e)
    });
  }

  async saveDataStructure(data, options: any = {}) {
    const storageId = await ipfsHelper.getIpldHashFromObject(data);

    await this.ms.database.addObject({
      data: JSON.stringify(data),
      storageId
    }).catch(() => {/* already saved */});

    const storagePromise = this.ms.storage.saveObject(data);
    if(options.waitForStorage) {
      await storagePromise;
    }

    return storageId;
  }

  async getAllUserList(adminId, searchString?, listParams?: IListParams) {
    listParams = this.prepareListParams(listParams);
    await this.checkUserCan(adminId, CorePermissionName.AdminRead);
    return {
      list: await this.ms.database.getAllUserList(searchString, listParams),
      total: await this.ms.database.getAllUserCount(searchString)
    }
  }

  async getAllContentList(adminId, searchString?, listParams?: IListParams) {
    listParams = this.prepareListParams(listParams);
    await this.checkUserCan(adminId, CorePermissionName.AdminRead);
    return {
      list: await this.ms.database.getAllContentList(searchString, listParams),
      total: await this.ms.database.getAllContentCount(searchString)
    }
  }

  async getUserLimit(adminId, userId, limitName) {
    await this.checkUserCan(adminId, CorePermissionName.AdminRead);
    return this.ms.database.getUserLimit(userId, limitName);
  }

  async isUserCan(userId, permission) {
    const userCanAll = await this.ms.database.isHaveCorePermission(userId, CorePermissionName.UserAll);
    if (userCanAll) {
      return true;
    }
    return this.ms.database.isHaveCorePermission(userId, permission);
  }

  async checkUserCan(userId, permission) {
    if (_.startsWith(permission, 'admin:')) {
      if (await this.ms.database.isHaveCorePermission(userId, CorePermissionName.AdminAll)) {
        return;
      }
    } else { // user:
      if (await this.ms.database.isHaveCorePermission(userId, CorePermissionName.UserAll)) {
        return;
      }
    }
    if (!await this.ms.database.isHaveCorePermission(userId, permission)) {
      throw new Error("not_permitted");
    }
  }

  runSeeds() {
    return require('./seeds')(this);
  }

  async getPeers(topic) {
    const peers = await this.ms.communicator.getPeers(topic);
    return {
      count: peers.length,
      list: peers
    }
  }

  async getStaticIdPeers(ipnsId) {
    const peers = await this.ms.communicator.getStaticIdPeers(ipnsId);
    return {
      count: peers.length,
      list: peers
    }
  }

  checkStorageId(storageId) {
    if (ipfsHelper.isCid(storageId)) {
      storageId = ipfsHelper.cidToHash(storageId);
    }

    if (storageId['/']) {
      storageId = storageId['/'];
    }

    return storageId;
  }

  async getSelfAccountId() {
    return this.ms.communicator.getAccountIdByName('self');
  }

  async createStorageAccount(name) {
    const storageAccountId = await this.ms.communicator.createAccountIfNotExists(name + commonHelper.makeCode(8));

    this.ms.communicator.getAccountPublicKey(storageAccountId).then(publicKey => {
      return this.ms.database.setStaticIdKey(storageAccountId, peerIdHelper.publicKeyToBase64(publicKey)).catch(() => {
        /*dont do anything*/
      });
    }).catch(e => {
      console.warn('error public key caching', e);
    });
    return storageAccountId;
  }

  async resolveStaticId(staticId): Promise<any> {
    return new Promise(async (resolve, reject) => {
      let alreadyHandled = false;

      const staticIdItem = await this.ms.database.getActualStaticIdItem(staticId);

      setTimeout(() => {
        if(alreadyHandled) {
          return;
        }
        alreadyHandled = true;
        log('resolve by timeout', staticId, '=>', staticIdItem ? staticIdItem.dynamicId : null);
      }, 1000);

      let dynamicId;
      try {
        let dynamicItem = await this.ms.communicator.resolveStaticItem(staticId);
        if (staticIdItem && dynamicItem && dynamicItem.createdAt > staticIdItem.boundAt.getTime() / 1000) {
          dynamicId = dynamicItem.value;
          log('resolve by communicator', staticId, '=>', dynamicId);
        } else if (staticIdItem) {
          dynamicId = staticIdItem.dynamicId;
          log('resolve by database', staticId, '=>', dynamicId);
        }
      } catch (err) {
        console.error('communicator.resolveStaticId error', err);
        if (staticIdItem) {
          alreadyHandled = true;
          log('resolve by catch', staticId, '=>', staticIdItem.dynamicId);
          return resolve(staticIdItem.dynamicId);
        } else {
          throw (err);
        }
      }

      resolve(dynamicId);
      alreadyHandled = true;
      if (dynamicId && dynamicId !== 'null') {
        return this.ms.database.addStaticIdHistoryItem({
          staticId: staticId,
          dynamicId: dynamicId,
          isActive: true,
          boundAt: new Date()
        }).catch(() => {/* already have */});
      }
    });
  }

  async getBootNodes(userId, type = 'ipfs') {
    await this.checkUserCan(userId, CorePermissionName.AdminRead);
    if (type === 'ipfs') {
      return this.ms.storage.getBootNodeList();
    } else {
      return this.ms.communicator.getBootNodeList();
    }
  }

  async addBootNode(userId, address, type = 'ipfs') {
    await this.checkUserCan(userId, CorePermissionName.AdminAddBootNode);
    if (type === 'ipfs') {
      return this.ms.storage.addBootNode(address).catch(e => console.error('storage.addBootNode', e));
    } else {
      return this.ms.communicator.addBootNode(address).catch(e => console.error('communicator.addBootNode', e));
    }
  }

  async removeBootNode(userId, address, type = 'ipfs') {
    await this.checkUserCan(userId, CorePermissionName.AdminRemoveBootNode);
    if (type === 'ipfs') {
      return this.ms.storage.removeBootNode(address).catch(e => console.error('storage.removeBootNode', e));
    } else {
      return this.ms.communicator.removeBootNode(address).catch(e => console.error('communicator.removeBootNode', e));
    }
  }

  async stop() {
    await this.ms.storage.stop();
    await this.ms.communicator.stop();
    this.ms.api.stop();
  }
}

interface IStorageFile {
  size,
  id,
  tempPath?,
  emitFinish?
}