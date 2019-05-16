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
import Vue from 'vue';
import Router from 'vue-router';
import MainPage from "./pages/MainPage/MainPage";
import GroupPage from "./pages/GroupPage/GroupPage";
import LoginPage from "./pages/LoginPage/LoginPage";

Vue.use(Router);

export default new Router({
    //mode: 'history',
    routes: [
        {
            path: '',
            name: 'main-page',
            component: MainPage
        },
        {
            path: 'login',
            name: 'login',
            component: LoginPage
        },
        {
            path: '/group/:groupId',
            name: 'group-page',
            component: GroupPage
        },
        {
            path: '*', redirect: '/'
        }
    ]
})
