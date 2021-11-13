/*
 * Copyright ©️ 2018-2020 Galt•Project Society Construction and Terraforming Company
 * (Founded by [Nikolai Popeka](https://github.com/npopeka)
 *
 * Copyright ©️ 2018-2020 Galt•Core Blockchain Company
 * (Founded by [Nikolai Popeka](https://github.com/npopeka) by
 * [Basic Agreement](ipfs/QmaCiXUmSrP16Gz8Jdzq6AJESY1EAANmmwha15uR3c1bsS)).
 */

import {IGeesomeApp} from "../components/app/interface";
import {
  CorePermissionName,
} from "../components/database/interface";

// const ipfsHelper = require("geesome-libs/src/ipfsHelper");
// const assert = require('assert');
const log = require('../components/log');
const { generateRandomData } = require('./helpers');
const pIteration = require('p-iteration');
const _ = require('lodash');

(async () => {
  const databaseConfig = {name: 'geesome_test', options: {logging: () => {}}};
  const appConfig = require('../components/app/v1/config');
  appConfig.storageConfig.jsNode.repo = '.jsipfs-test';
  appConfig.storageConfig.jsNode.pass = 'test test test test test test test test test test';
  appConfig.storageConfig.jsNode.config = {
    Addresses: {
      Swarm: [
        "/ip4/0.0.0.0/tcp/40002",
        "/ip4/127.0.0.1/tcp/40003/ws",
        "/dns4/wrtc-star.discovery.libp2p.io/tcp/443/wss/p2p-webrtc-star"
      ]
    }
  };
  let app: IGeesomeApp;
  let group, user;

  try {
    app = await require('../components/app/v1')({databaseConfig, storageConfig: appConfig.storageConfig, port: 7771});

    await app.setup({email: 'admin@admin.com', name: 'admin', password: 'admin'});
    user = await app.registerUser({email: 'user@user.com', name: 'user', password: 'user', permissions: [CorePermissionName.UserAll]});
    group = await app.createGroup(user.id, {
      name: 'microwave',
      title: 'Microwave'
    }).then(() => app.getGroupByParams({name: 'microwave'}));
  } catch (e) {
    console.error(e);
    // group = await app.createGroup(user.id, {
    //   name: 'microwave',
    //   title: 'Microwave'
    // })
  }

  const TelegramClient = require('../components/socNetClient/telegram');
  const telegram = new TelegramClient();
  await telegram.init(await app.database.getDriver());

  // https://my.telegram.org/
  // const res = await telegram.login(user.id, {
  //   phoneNumber: '',
  //   password: '',
  //   apiId: '',
  //   apiHash: '',
  //   phoneCodeHash: '',
  //   phoneCode: ''
  // });
  // console.log('res', res);

  // await app.database['models'].Post.destroy({where: {}});
  //
  // let groupedId = null;
  // let groupedContent = [];
  // const {client, result: messages} = await telegram.getMessagesByUserId(2, 'inside_microwave', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25]); //1,2,3,4,5,
  // await pIteration.forEachSeries(messages, async (m, i) => {
  //   let contents = [];
  //
  //   if (m.media) {
  //     // console.log('m.media.mimeType', m.media);
  //     // console.log('downloadMedia', await telegram.downloadMedia(2, m.media));
  //     const {result: file} = await telegram.downloadMediaByClient(client, m.media);
  //     const content = await app.saveData(file.content, '', {
  //       mimeType: file.mimeType,
  //       userId: 3,
  //     });
  //     contents.push(content);
  //
  //     if (m.media.webpage) {
  //       //TODO: add view type - link
  //       const content = await app.saveData(m.media.webpage.url, '', {
  //         mimeType: 'text/plain',
  //         userId: 3,
  //       });
  //       contents.push(content);
  //     }
  //   }
  //
  //   if (m.message) {
  //     const content = await app.saveData(m.message, '', {
  //       mimeType: 'text/plain',
  //       userId: 3,
  //     });
  //     contents.push(content);
  //   }
  //
  //   console.log('m.groupedId', m.groupedId && m.groupedId.toString());
  //   if (
  //       (groupedId && !m.groupedId) || // group ended
  //       (groupedId && m.groupedId && m.groupedId.toString() !== groupedId) || // new group
  //       i === messages.length - 1 // messages end
  //   ) {
  //     await app.createPost(4, {
  //       groupId: 2,
  //       contents: groupedContent,
  //     });
  //     groupedContent = [];
  //     groupedId = null;
  //   }
  //
  //   if (m.groupedId) {
  //     groupedContent = groupedContent.concat(contents);
  //     groupedId = m.groupedId.toString();
  //   } else {
  //     if (contents.length) {
  //       return app.createPost(4, {
  //         groupId: 2,
  //         contents,
  //       })
  //     }
  //   }
  // });

  const ssg = await require('../components/render/static-site-generator')(app);
  await ssg.generateContent('group', 2);

  // await app.database.flushDatabase();
  // await app.stop();
})();