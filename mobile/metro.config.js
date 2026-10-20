// コア(../src)と素材(../design-assets)をモバイルのバンドルに含める。node_modules は mobile 側だけを見る。
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const root = path.resolve(__dirname, '..');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.join(root, 'src'), path.join(root, 'design-assets')];
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;
module.exports = config;
