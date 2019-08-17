/*
 * Copyright ©️ 2018 Galt•Space Society Construction and Terraforming Company 
 * (Founded by [Nikolai Popeka](https://github.com/npopeka),
 * [Dima Starodubcev](https://github.com/xhipster), 
 * [Valery Litvin](https://github.com/litvintech) by 
 * [Basic Agreement](http://cyb.ai/QmSAWEG5u5aSsUyMNYuX2A2Eaz4kEuoYWUkVBRdmu9qmct:ipfs)).
 * ​
 * Copyright ©️ 2018 Galt•Core Blockchain Company 
 * (Founded by [Nikolai Popeka](https://github.com/npopeka) and 
 * Galt•Space Society Construction and Terraforming Company by 
 * [Basic Agreement](http://cyb.ai/QmaCiXUmSrP16Gz8Jdzq6AJESY1EAANmmwha15uR3c1bsS:ipfs)).
 */

import GroupItem from "./GroupItem/GroupItem";
import AddFriendModal from "../../modals/AddFriendModal/AddFriendModal";
import {EventBus, UPDATE_GROUP} from "../../services/events";
import MessageItem from "./MessageItem/MessageItem";
const _ = require('lodash');

export default {
  name: 'chat-page',
  template: require('./ChatPage.html'),
  components: {GroupItem, MessageItem},
  async created() {
    
  },
  mounted() {
    this.getGroups();
    if(this.selectedGroupId) {
      this.getGroupPosts(0);
    }
  },
  methods: {
    async getGroups() {
      this.groups = await this.$coreApi.getMemberInChats();

      this.groups.forEach((group) => {
        if (group.type === 'personal_chat') {
          this.$coreApi.subscribeToPersonalChatUpdates(group.members, 'default', (event) => this.fetchGroupUpdate(group, event));
        } else {
          this.$coreApi.subscribeToGroupUpdates(group.ipns, 'default', (event) => this.fetchGroupUpdate(group, event));
        }
      });
    },
    async fetchGroupUpdate(group, event) {
      console.log('fetchGroupUpdate', group, event);
      const post = await this.$coreApi.getPost(event.dataJson.postIpld);
      if(group.ipns === this.selectedGroupId) {
        this.messages.unshift(post);
      }
      
      this.$identities.loading('lastPost', group.id);
      this.$identities.set('lastPost', group.id, post);
      this.$identities.set('lastPostText', group.id, await this.$coreApi.getContentData(post.contents[0]));
    },
    getGroupPosts(offset) {
      this.messagesLoading = true;
      
      if(offset === 0) {
        this.messages = [];
      }
      return this.$coreApi.getGroupPostsAsync(this.selectedGroupId, {
        limit: this.messagesPagination.perPage,
        offset
        // offset: (this.messagesPagination.currentPage - 1) * this.messagesPagination.perPage
      }, (posts) => {
        this.appendMessages(posts);
      }, (posts) => {
        this.appendMessages(posts);
        this.messagesLoading = false;
      });
    },
    
    appendMessages(messages) {
      //TODO: more effective appendMessages
      this.messages = messages;
      
      this.messages.forEach(async message => {
        if(this.usersInfoLoading[message.author]) {
          return;
        }
        this.$identities.loading('usersInfo', message.author);
        this.$identities.set('usersInfo', message.author, await this.$coreApi.getUser(message.author));
      });
    },
    addFriend() {
      this.$root.$asyncModal.open({
        id: 'add-friend-modal',
        component: AddFriendModal,
        onClose: () => {
          this.getGroups();
        }
      });
    },
    onEnter(event) {
      if(event.shiftKey) {
        return;
      }
      this.newMessage.text = _.trimEnd(this.newMessage.text, "\n");
      this.sendMessage();
    },
    async sendMessage() {
      const contentsIds = [];
      
      const text = this.newMessage.text;
      
      this.newMessage.text = '';
      
      const textContent = await this.$coreApi.saveContentData(text, {
        groupId: this.selectedGroupId,
        mimeType: 'text/markdown'
      });

      contentsIds.push(textContent.id);
      
      await this.$coreApi.createPost(contentsIds, {groupId: this.selectedGroupId, status: 'published'}).then(() => {
        this.saving = false;
        this.$emit('new-post');
        EventBus.$emit(UPDATE_GROUP, this.selectedGroupId);
      });

      // await this.getGroupPosts(0);
    },
    getLocale(key, options?) {
      return this.$locale.get(this.localeKey + "." + key, options);
    }
  },
  watch: {
    selectedGroupId() {
       this.getGroupPosts(0);
    }
  },
  computed: {
    selectedGroupId() {
      return this.$route.params.groupId;
    },
    currentGroup() {
      return _.find(this.groups, {ipns: this.selectedGroupId});
    },
    user() {
      return this.$store.state.user;
    },
    usersInfo() {
      return this.$store.state.usersInfo;
    },
    usersInfoLoading() {
      return this.$store.state.usersInfoLoading;
    },
  },
  data() {
    return {
      localeKey: 'chat_page',
      loading: true,
      groups: [],
      messages: [],
      messagesLoading: false,
      messagesPagination: {
        currentPage: 1,
        perPage: 20
      },
      newMessage: {
        text: ''
      }
    };
  }
}
