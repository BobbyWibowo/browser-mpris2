/* global chrome, $ */

'use strict'

// Lifesaver: https://stackoverflow.com/a/34100952

class Playlist {
  constructor ({ loop = false, shuffle = false } = {}) {
    this.id = ''
    this.index = -1
    this.length = 0
    this.loop = loop
    this.shuffle = shuffle
  }
}

class EventObserver {
  constructor (element, event, handler) {
    this.element = element
    this.event = event
    this.handler = handler

    element.addEventListener(event, this.handler)
  }

  disconnect () {
    this.element.removeEventListener(this.event, this.handler)
  }
}

let videoElement

let video
let playlist = new Playlist()

let prevUrl
let observers = []

let waitPageTimeout

function isVideo (url = location) {
  return url.pathname.startsWith('/watch')
}

function loopStatus () {
  if (videoElement.loop)
    return 'Track'
  if (playlist.length && playlist.loop)
    return 'Playlist'
  return 'None'
}

function enterVideo (title, artist, element) {
  const id = (new URL(location)).searchParams.get('v')

  observers.forEach(obs => obs.disconnect())
  observers = []
  videoElement = element

  video = {
    Metadata: {
      'mpris:trackid': id,
      'mpris:artUrl': `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      'xesam:url': location.href,
      'xesam:title': title,
      'xesam:artist': [artist]
    },
    PlaybackStatus: 'Playing'
  }

  const eventHandlers = {
    play () { changed({ PlaybackStatus: 'Playing' }) },
    playing () { changed({ PlaybackStatus: 'Playing' }) },
    pause () { changed({ PlaybackStatus: 'Paused' }) },
    ended () { changed({ PlaybackStatus: 'Stopped' }) },

    // when a seek operation completes
    // FIXME: it seems that YouTube is "sending" too many seeked events
    // e.g., according to mpris Playing from the beginning after being
    // Stopped should not be considered a Seek, yet YouTube does send a
    // seeked event and we propagate that to DBus as well
    seeked (e) { seeked(Math.trunc(e.target.currentTime * 1e6)) },

    // when the playback speed changes
    ratechange (e) { changed({ Rate: e.target.playbackRate }) },

    // a change in the duration of the media
    // durationchange(e) { update({ "mpris:length": Math.trunc(e.target.duration * 1e6) }); },

    // when the audio volume changes or is muted
    volumechange (e) { changed({ Volume: e.target.muted ? 0.0 : e.target.volume }) }
  }

  for (const [event, handler] of Object.entries(eventHandlers))
    observers.push(new EventObserver(videoElement, event, handler))
  video.Metadata['mpris:length'] = Math.trunc(videoElement.duration * 1e6)

  const loopObserver = new MutationObserver(muts => {
    muts.forEach(m => changed({ LoopStatus: loopStatus() }))
  })
  loopObserver.observe(videoElement, {
    subtree: false,
    attributes: true,
    attributeFilter: ['loop']
  })
  observers.push(loopObserver)

  observers.push(new EventObserver(document, 'webkitfullscreenchange', e => {
    // We'll assume that it's the video that was made fullscreen.
    changed({ Fullscreen: !!document.webkitFullscreenElement })
  }))

  // Playlist related
  playlist = new Playlist(playlist)

  const pl = $('#playlist')

  const plHeader = pl.find('.header')
  if (plHeader.length) {
    playlist.id = (new URL(location)).searchParams.get('list')
    playlist.title = plHeader.find('.title').text()

    const indexMessage = plHeader.find('.index-message').text().split(' / ')
    playlist.index = Number.parseInt(indexMessage[0]) - 1
    playlist.length = Number.parseInt(indexMessage[1])
  }

  if (playlist.length) {
    const loopButton = $('#playlist-actions a').get(0)
    observers.push(new EventObserver(loopButton, 'click', () => {
      playlist.loop = !playlist.loop
      changed({ LoopStatus: loopStatus() })
    }))

    const shuffleButton = $('#playlist-actions a').get(1)
    observers.push(new EventObserver(shuffleButton, 'click', () => {
      playlist.shuffle = !playlist.shuffle
      changed({ Shuffle: playlist.shuffle })
    }))
  }

  video.LoopStatus = loopStatus()
  video.Shuffle = playlist.shuffle

  // It looks like YouTube does not always set the volume of the <video> to
  // 1, even if the player says that it is max.  I don't know why they do
  // that, but let's respect it by lying to MPRIS!
  video.Volume = 1

  video.CanGoNext = ($('.ytp-next-button').attr('aria-disabled') === 'false')
  video.CanGoPrevious = ($('.ytp-prev-button').attr('aria-disabled') === 'false')

  video.Rate = videoElement.playbackRate

  changed(video)
}

const COMMANDS = {
  Get (_, propName) {
    switch (propName) {
      case 'Position':
        return Math.trunc(videoElement.currentTime * 1e6)
    }
  },

  Set (_, propName, newValue) {
    switch (propName) {
      case 'Rate':
        setPlaybackRate(newValue)
        break

      case 'Volume':
        // we only mute (if needed); see the other comment on volume
        if ((!newValue && !videoElement.muted) || (newValue && videoElement.muted))
          $('.ytp-mute-button').get(0).click()
        break

      case 'Shuffle':
        if ((newValue && !playlist.shuffle) || (!newValue && playlist.shuffle))
          $('#playlist-actions a').get(1).click()
        break

      case 'LoopStatus':
        switch (newValue) {
          case 'None':
            setLoop(false)
            setPlaylistLoop(false)
            break
          case 'Track':
            setLoop(true)
            break
          case 'Playlist':
            if (!playlist.length)
              return
            setLoop(false)
            setPlaylistLoop(true)
            break
        }
        break

      default:
      case 'Fullscreen':
    }
  },

  Pause () {
    videoElement.pause()
  },
  Play () {
    videoElement.play()
  },
  PlayPause () {
    if (videoElement.paused || videoElement.ended)
      videoElement.play()
    else
      videoElement.pause()
  },
  Stop () {
    videoElement.currentTime = videoElement.duration
  },

  Next () {
    const nextBtn = $('.ytp-next-button')
    if (nextBtn.attr('aria-disabled') === 'false')
      nextBtn.get(0).click()
  },
  Previous () {
    const prevBtn = $('.ytp-prev-button')
    if (prevBtn.attr('aria-disabled') === 'false') {
      if (videoElement.currentTime > 2)
      // if the video is past its 2nd second pressing prev will start
      // it from the beginning again, so we need to press twice with
      // a bit of a delay between
        setTimeout(() => prevBtn.get(0).click(), 100)
      prevBtn.get(0).click()
    }
  },

  Seek (offset) {
    videoElement.currentTime += offset / 1e6
    if (videoElement.currentTime >= videoElement.duration)
      this.Next()
  },
  SetPosition (id, position) {
    // TODO: perhaps store the ID somewhere?
    if (id === (new URL(location)).searchParams.get('v'))
      videoElement.currentTime = position / 1e6
  }
}

function setPlaylistLoop (yes) {
  if (playlist.length && ((yes && !playlist.loop) || (!yes && playlist.loop)))
    $('#playlist-actions a').get(0).click()
}

function setLoop (yes) {
  if ((yes && videoElement.loop) || (!yes && !videoElement.loop))
    return

  const rightClick = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    buttons: 2
  })

  // fake right click for the menu to show up
  videoElement.dispatchEvent(rightClick)
  // then click on the "Loop" button
  $('.ytp-contextmenu .ytp-menuitem').get(3).click()
}

function setPlaybackRate (rate) {
  if (rate <= 0)
    return
  const closestRate = rate <= 1.75 ? Math.ceil(rate * 4) : 7

  // first make the settings menu appear
  $('.ytp-settings-button').get(0).click()
  // then the "speed" submenu
  $('.ytp-settings-menu .ytp-menuitem').get(1).click()

  // set a timeout because of animation delays
  setTimeout(() => {
    // select the closest speed
    $('.ytp-settings-menu .ytp-menuitem').get(closestRate - 1).click()
    // and close the settings menu again
    $('.ytp-settings-button').get(0).click()
  }, 300)
}

const port = chrome.runtime.connect()
port.onMessage.addListener(cmd => {
  // console.log("MethodCall", cmd);
  if (videoElement) {
    const result = COMMANDS[cmd.method](...cmd.args)
    methodReturn(cmd.method, result)
  }
})

function changed (newValues) {
  port.postMessage({
    source: 'youtube', type: 'changed', args: [newValues]
  })
}

function seeked (position) {
  port.postMessage({
    source: 'youtube', type: 'seeked', args: [position]
  })
}

function methodReturn (method, args) {
  port.postMessage({
    source: 'youtube', type: 'return', method, args
  })
}

function quit () {
  port.postMessage({
    source: 'youtube', type: 'quit'
  })
}

function waitPage () {
  if (waitPageTimeout) clearTimeout(waitPageTimeout)

  const title = $('h1.title yt-formatted-string').get(0)
  const artist = $('yt-formatted-string#owner-name').get(0)
  const element = $('video').get(0)

  if (title && title.innerText && artist && artist.innerText && element && element.duration)
    return enterVideo(title.innerText, artist.innerText, element)

  waitPageTimeout = setTimeout(() => waitPage(), 1000)
}

window.addEventListener('DOMContentLoaded', e => {
  if (chrome.extension.inIncognitoContext) return
  prevUrl = new URL(location)
})

// When navigating between YouTube pages of different types.
// window.addEventListener("yt-page-type-changed", e => {
//     console.log({source: "youtube", type: e.type, url: location.href});
// });

// When a YouTube page finished loading.
// There's also "yt-navigate-start" which fires too early or not at all for
// cached pages; and "yt-navigate-finish" which also fires early.
window.addEventListener('yt-page-data-updated', e => {
  if (chrome.extension.inIncognitoContext) return
  const nextUrl = new URL(location)

  if (!isVideo() || (isVideo(prevUrl) && playlist.id !== nextUrl.searchParams.get('list')))
    playlist = new Playlist()

  if (isVideo()) {
    waitPage()
  } else {
    if (waitPageTimeout)
      clearTimeout(waitPageTimeout)
    if (videoElement)
      quit()
  }

  prevUrl = nextUrl
})
