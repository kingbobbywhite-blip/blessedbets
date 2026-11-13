// Flic Hub SDK module: true hold-to-talk for Switchboard.
//
// With a Flic Hub (LR or Mini), button events can run JavaScript on the hub.
// This module records while the button is held: press = start talking,
// release = send. Double click cancels and stops anything being read aloud.
//
// Setup: open https://hubsdk.flic.io, connect to your hub, create a module,
// paste this file, fill in the two settings below, and start it.
// The phone (or browser) must have walk mode open.

var SWITCHBOARD_URL = 'https://your-mac.your-tailnet.ts.net' // your SWITCHBOARD_PUBLIC_URL
var TOKEN = 'paste-the-token-from-switchboard-pair-here'
// Only react to these buttons (by name in the Flic app); empty means all.
var BUTTONS = []

var buttonManager = require('buttonManager')
var http = require('http')

function wanted(bdaddr) {
  if (!BUTTONS.length) return true
  var b = buttonManager.getButton(bdaddr)
  return b && BUTTONS.indexOf(b.name) !== -1
}

function ptt(action) {
  http.makeRequest(
    {
      url: SWITCHBOARD_URL + '/api/ptt/' + action + '?token=' + encodeURIComponent(TOKEN),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      content: '{}',
    },
    function (err, res) {
      if (err) console.log('switchboard ' + action + ' failed: ' + err)
      else if (res.statusCode !== 200) console.log('switchboard ' + action + ': HTTP ' + res.statusCode + ' ' + res.content)
    },
  )
}

buttonManager.on('buttonDown', function (obj) {
  if (wanted(obj.bdaddr)) ptt('start')
})

buttonManager.on('buttonUp', function (obj) {
  if (wanted(obj.bdaddr)) ptt('stop')
})

buttonManager.on('buttonSingleOrDoubleClickOrHold', function (obj) {
  if (wanted(obj.bdaddr) && obj.isDoubleClick) ptt('cancel')
})

console.log('Switchboard push-to-talk ready')
