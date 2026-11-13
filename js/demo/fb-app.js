// firebase-app для демо-будинку.
export const initializeApp = (config = {}) => ({ name: '[DEFAULT]', options: config, automaticDataCollectionEnabled: false });
export const getApp = () => ({ name: '[DEFAULT]', options: {} });
export const getApps = () => [getApp()];
export const SDK_VERSION = 'demo';
