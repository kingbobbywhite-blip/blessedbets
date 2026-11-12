// Share the hub's protocol types with the app instead of keeping a copy.
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../src/shared')]
module.exports = config
