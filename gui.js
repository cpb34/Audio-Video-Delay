document.addEventListener('DOMContentLoaded', () => {
  const delayInput = document.getElementById('delay')
  const toggleButton = document.getElementById('toggle')
  const toggleText = toggleButton.querySelector('.toggle-text')
  const modeToggle = document.getElementById('mode-toggle')
  const delayType = document.getElementById('delay-type')
  
  const subtitleToggleButton = document.getElementById('subtitle-toggle')

  function sendDelayStatus(delay, enabled) {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'setDelay',
          mode: modeToggle.textContent,
          delay: enabled && delay >= 0 ? delay : 0
        }, (response) => { if (chrome.runtime.lastError) {} })
      }
    })
  }

  function sendSubtitleDelayStatus(subtitleDelay) {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'setSubtitleDelay',
          subtitleDelay: subtitleDelay
        }, (response) => { if (chrome.runtime.lastError) {} })
      }
    })
  }

  function sendDelayValue(delay) {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'updateDelay',
          delay: delay
        }, (response) => { if (chrome.runtime.lastError) {} })
      }
    })
  }

  function updateDelayMode() {
    const mode = modeToggle.textContent
    delayType.textContent = mode
    modeToggle.className = mode.toLowerCase()
    updateSubtitleToggleAppearance()
  }

  function updateSubtitleToggleAppearance() {
    const isEnabled = toggleButton.classList.contains('active')
    const mode = modeToggle.textContent
    const shouldGrayOut = !isEnabled || mode === 'Audio'

    if (subtitleToggleButton) subtitleToggleButton.classList.toggle('disabled', shouldGrayOut)
  }

  function setAndSendValues() {
    const isEnabled = toggleButton.classList.contains('active')
    const currentDelay = parseInt(delayInput.value) || 0
    
    chrome.storage.local.set({ 
      enabled: isEnabled,
      delay: currentDelay,
      mode: modeToggle.textContent
    }, function() { sendDelayStatus(currentDelay, isEnabled) })
  }

  function setAndSendSubtitleDelayValue() {
    const isSubtitleDelayEnabled = subtitleToggleButton.classList.contains('active')

    chrome.storage.local.set({
      subtitleDelay: isSubtitleDelayEnabled
    }, function() { sendSubtitleDelayStatus(isSubtitleDelayEnabled) })
  }

  function updateDelayValue() {
    const currentDelay = parseInt(delayInput.value) || 0
    
    chrome.storage.local.set({ 
      delay: currentDelay
    }, function() { sendDelayValue(currentDelay) })
  }
  
  chrome.storage.local.get(['delay', 'enabled', 'mode', 'subtitleDelay'], function(result) {
    if (result.delay != undefined) delayInput.value = result.delay

    if (result.mode != undefined) {
      modeToggle.textContent = result.mode
      updateDelayMode()
    }

    if (result.enabled != undefined) {
      toggleButton.classList.toggle('active', result.enabled)
      toggleText.textContent = result.enabled ? 'ON' : 'OFF'
    }

    const isSubtitleDelayEnabled = result.subtitleDelay !== false
    if (subtitleToggleButton) {
      subtitleToggleButton.classList.toggle('active', isSubtitleDelayEnabled)
    }

    updateSubtitleToggleAppearance()
  })

  modeToggle.addEventListener('pointerdown', () => {
    const newMode = modeToggle.textContent == 'Video' ? 'Audio' : 'Video'
    modeToggle.textContent = newMode
    updateDelayMode()
    setAndSendValues()
  })

  toggleButton.addEventListener('pointerdown', () => {
    const isEnabled = toggleButton.classList.toggle('active')
    toggleText.textContent = isEnabled ? 'ON' : 'OFF'
    updateSubtitleToggleAppearance()
    setAndSendValues()
  })

  if (subtitleToggleButton) {
    subtitleToggleButton.addEventListener('pointerdown', () => {
      const isSubtitleDelayEnabled = subtitleToggleButton.classList.toggle('active')
      setAndSendSubtitleDelayValue()
    })
  }

  delayInput.addEventListener('input', () => { updateDelayValue() })
  delayInput.addEventListener('keydown', function(k) { if (k.key == '-' || k.key == '+') k.preventDefault() })
})