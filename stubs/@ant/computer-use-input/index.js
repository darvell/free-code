const path = require('path');

// Load the extracted native module
const nativePath = path.resolve(__dirname, '..', '..', '..', 'vendor', 'native', 'computer-use-input.node');
const native = require(nativePath);

// The package exports a discriminated union: { isSupported: true, ...api } | { isSupported: false }
// On macOS with the native module available, we export the supported variant.
if (process.platform === 'darwin') {
  module.exports = {
    isSupported: true,
    ...native,
  };
} else {
  module.exports = {
    isSupported: false,
  };
}
