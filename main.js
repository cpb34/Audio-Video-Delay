class Monitor {
  constructor() { 
    this.videoCallbacks = new Map()
    this.delayedVideos = new Map()
    this.startMonitor()
  }

  startMonitor() {
    try {
      chrome.storage.local.get(['mode', 'delay', 'enabled'], (result) => {
        this.delay = result.delay
        this.mode = result.mode
        this.enabled = result.enabled

        if (result.enabled && result.mode === 'Video') {
          this.setupVideoListeners()
        } else if (result.enabled && result.mode === 'Audio') {
          if (!this.delayedAudio) this.delayedAudio = new DelayedAudio(this.delay)
          else this.delayedAudio.updateDelayedAudio(this.delay, true)
        }
      })

      chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'setDelay') {
          chrome.storage.local.get(['mode', 'enabled'], (result) => {
            this.delay = message.delay
            this.mode = result.mode
            this.enabled = result.enabled

            this.stopVideoDelay(null)

            if (this.delayedAudio) this.delayedAudio.stopDelayedAudio()

            if (result.enabled && result.mode === 'Video') {
              this.setupVideoListeners()
            } else if (result.enabled && result.mode === 'Audio') {
              if (!this.delayedAudio) this.delayedAudio = new DelayedAudio(this.delay)
              else this.delayedAudio.updateDelayedAudio(this.delay, true)
            }
          })
        } else if (message.type === 'updateDelay') {
          chrome.storage.local.get(['mode', 'enabled'], (result) => {
            if (!result.enabled) return

            this.delay = message.delay
            
            if (result.mode === 'Video') this.delayedVideos.forEach((delayedVideo) => { delayedVideo.updateDelayedVideo(this.delay) })
            else if (this.delayedAudio) this.delayedAudio.updateDelayedAudio(this.delay, false)
          })
        }
      })
    } catch {}
  }

  setupVideoListeners() {
    if (this.observer) {
      this.observer.disconnect()
      this.observer = null
    }

    this.clearVideoCallbacks()

    document.querySelectorAll('video').forEach(video => { this.waitForVideoFrameRefresh(video) })

    this.observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.tagName === 'VIDEO') this.waitForVideoFrameRefresh(node)
          else if (node.querySelectorAll) node.querySelectorAll('video').forEach(video => this.waitForVideoFrameRefresh(video))
        })
      })
    })

    this.observer.observe(document.documentElement, { childList: true, subtree: true })
  }

  clearVideoCallbacks() {
    this.videoCallbacks.forEach((callbackId, video) => { if ('cancelVideoFrameCallback' in HTMLVideoElement.prototype) try { video.cancelVideoFrameCallback(callbackId) } catch {} })
    this.videoCallbacks.clear()
  }

  waitForVideoFrameRefresh(video) {
    if (video.closest('.video-delay-container') || video.closest('.video-delay-container-relative') || this.videoCallbacks.has(video) || this.delayedVideos.has(video)) return

    const requestFrameCallback = () => {
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        const callbackId = video.requestVideoFrameCallback((now, metadata) => {
          this.videoCallbacks.delete(video)

          if (video.paused) return

          this.delayVideo(video)
        })

        this.videoCallbacks.set(video, callbackId)
      }
    }

    requestFrameCallback()

    const onPlay = () => { if (!video.paused && !this.videoCallbacks.has(video) && !this.delayedVideos.has(video)) requestFrameCallback() }
    
    video.addEventListener('play', onPlay)
    video.addEventListener('loadstart', onPlay)
  }

  delayVideo(video) {
    if (window.location.hostname.includes('instagram.com')) {
      this.delayedVideos.forEach((delayedVideo, trackedVideo) => { if (trackedVideo.paused) this.cleanupDelayedVideo(trackedVideo) })

      const delayedVideo = new DelayedVideo(video, this.delay)
      this.delayedVideos.set(video, delayedVideo)

      return
    }

    const delayedVideo = new DelayedVideo(video, this.delay)
    this.delayedVideos.set(video, delayedVideo)
  }

  cleanupDelayedVideo(video) {
    const delayedVideo = this.delayedVideos.get(video)

    if (!delayedVideo) return
    
    delayedVideo.cleanupTextures()
    delayedVideo.stopDelayedVideo()
    this.delayedVideos.delete(video)
  }

  stopVideoDelay(videoToStop) {
    this.clearVideoCallbacks()
    
    if (this.observer) {
      this.observer.disconnect()
      this.observer = null
    }

    if (videoToStop) {
      this.cleanupDelayedVideo(videoToStop)
      this.startMonitor
    } else {
      this.delayedVideos.forEach((delayedVideo) => {
        delayedVideo.cleanupTextures()
        delayedVideo.stopDelayedVideo()
      })

      this.delayedVideos.clear()
    }
  }
}

class DelayedVideo {
  constructor(video, delay) {
    this.video = video
    this.originalDelay = delay
    this.delay = delay
    this.frameDelay = Math.max(Math.round(delay / 16.67) - 1, 0)

    this.timingMode = 'frame'
    this.frameCounter = 0
    this.lastRAFTime = performance.now()
    this.rafIntervals = []
    
    this.availableTextures = []
    this.usedTextures = new Set()

    this.subtitleElements = []
    this.hiddenSubtitleElements = []
    this.delayedSubtitleLines = []

    this.visibleTab = !document.hidden
    this.tabWasHidden = false
    this.videoEnded = false
    this.lastFrameShown = false
    this.restartDelayedVideo = false

    this.pendingTimeouts = []
    this.pendingRAFs = []

    this.addEventListeners()
    this.createCanvases()
    this.determineSubtitlePlayer()
    this.startDelayedVideo()
  }

  checkFrameRate(currentTime) {
    const interval = currentTime - this.lastRAFTime
    this.lastRAFTime = currentTime

    if (this.frameCounter < 10) return

    this.rafIntervals.push(interval)
    
    if (this.rafIntervals.length >= 10) {
      const avgInterval = this.rafIntervals.reduce((a, b) => a + b) / this.rafIntervals.length

      if (avgInterval < 14) this.switchToTimeMode()

      this.rafIntervals = []
    }
  }

  switchToTimeMode() {
    this.timingMode = 'time'
    this.delay = this.originalDelay
    this.videoStartTime = this.initiationTime
  }

  addEventListeners() {
    this.video.addEventListener('resize', () => { this.updateCanvasDimensions() })
    
    this.resizeObserver = new ResizeObserver(() => { this.updateCanvasDimensions() })
    this.resizeObserver.observe(this.video)
    
    this.videoEmptiedHandler = () => { monitor.stopVideoDelay(this.video) }
    
    this.video.addEventListener('emptied', this.videoEmptiedHandler)

    this.visibilityChangeHandler = () => {
      this.visibleTab = !document.hidden
      
      if (!this.visibleTab) this.tabWasHidden = true
    }

    document.addEventListener('visibilitychange', this.visibilityChangeHandler)
  }

  isPlex() {
    if (document.childNodes.length < 2 || document.childNodes[1].nodeType !== Node.COMMENT_NODE) return false
    
    const commentText = document.childNodes[1].textContent.trim()
    
    return commentText.includes('=======   ==') &&
           commentText.includes('/==   /== /==   =====   ==   ==') &&
           commentText.includes('/==////   /== /=======  //===') &&
           commentText.includes('/==       /== //======  == //==') &&
           commentText.includes('//        //   /////   //   //')
  }

  updateCanvasDimensions() {
    if (!this.videoCanvas || !this.video) return

    const videoStyle = window.getComputedStyle(this.video)
    
    this.videoCanvas.width = this.video.videoWidth
    this.videoCanvas.height = this.video.videoHeight

    const videoRect = this.video.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1

    this.videoCanvas.style.position = 'absolute'
    this.videoCanvas.style.top = '0'
    this.videoCanvas.style.left = '0'
    this.videoCanvas.style.width = `${this.video.offsetWidth}px`
    this.videoCanvas.style.height = `${this.video.offsetHeight}px`
    this.videoCanvas.style.transform = videoStyle.transform
    this.videoCanvas.style.zIndex = videoStyle.zIndex
    
    if (this.subtitleContext) {
      this.subtitleContext.setTransform(1, 0, 0, 1, 0, 0)
      this.subtitleContext.scale(dpr, dpr)
      this.subtitleContext.imageSmoothingEnabled = false
    }

    this.subtitleCanvas.width = videoRect.width * dpr
    this.subtitleCanvas.height = videoRect.height * dpr

    this.subtitleCanvas.style.position = 'absolute'
    this.subtitleCanvas.style.top = '0'
    this.subtitleCanvas.style.left = '0'
    this.subtitleCanvas.style.width = `${this.video.offsetWidth}px`
    this.subtitleCanvas.style.height = `${this.video.offsetHeight}px`
    this.subtitleCanvas.style.transform = videoStyle.transform

    if (this.gl) this.gl.viewport(0, 0, this.videoCanvas.width, this.videoCanvas.height)
}

  drawWebGLFrame(texture) {
    if (!this.gl || !texture || !this.gl.isTexture(texture)) return

    const gl = this.gl
    
    gl.useProgram(this.program)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer)
    gl.enableVertexAttribArray(this.positionAttributeLocation)
    gl.vertexAttribPointer(this.positionAttributeLocation, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer)
    gl.enableVertexAttribArray(this.texCoordAttributeLocation)
    gl.vertexAttribPointer(this.texCoordAttributeLocation, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.uniform1i(this.textureUniformLocation, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  async createCanvases() {
    if (!this.video) return

    this.videoCanvas = document.createElement('canvas')
    this.videoCanvas.style.setProperty('pointer-events', 'none', 'important')
    this.videoCanvas.style.setProperty('object-fit', 'contain', 'important')
    
    this.subtitleCanvas = document.createElement('canvas')
    this.subtitleCanvas.style.setProperty('pointer-events', 'none', 'important')
    this.subtitleCanvas.style.setProperty('object-fit', 'contain', 'important')

    if (!this.videoCanvas) return

    this.gl = this.videoCanvas.getContext('webgl2') || this.videoCanvas.getContext('webgl')

    if (!this.gl) return

    this.setupWebGL()

    this.subtitleContext = this.subtitleCanvas.getContext('2d', { alpha: true })

    if (this.video.parentNode) {
      this.video.parentNode.insertBefore(this.videoCanvas, this.video.nextSibling)
      this.video.parentNode.insertBefore(this.subtitleCanvas, this.videoCanvas.nextSibling)
    }

    if (this.subtitleContext) this.subtitleContext.imageSmoothingEnabled = false

    const framePromise = await this.captureFrame(performance.now())

    if (framePromise) {
      const frame = framePromise

      const initialTexture = this.getReusableTexture()

      this.gl.bindTexture(this.gl.TEXTURE_2D, initialTexture)
      this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.video)
      
      this.initialFrame = {
        texture: initialTexture,
        timestamp: frame.timestamp,
        frameNumber: frame.frameNumber
      }

      try { this.drawWebGLFrame(frame.texture) } catch {}
    }

    setTimeout(() => { this.video.style.setProperty('opacity', this.isPlex() ? '1' : '0', 'important') }, 17)
  }

  setupWebGL() {
    const gl = this.gl

    const vertexShaderSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `
    const fragmentShaderSource = `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;
      
      void main() {
        gl_FragColor = texture2D(u_texture, v_texCoord);
      }
    `
    const vertexShader = this.createShader(gl.VERTEX_SHADER, vertexShaderSource)
    const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, fragmentShaderSource)
    
    this.program = gl.createProgram()

    gl.attachShader(this.program, vertexShader)
    gl.attachShader(this.program, fragmentShader)
    gl.linkProgram(this.program)

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) return

    this.positionAttributeLocation = gl.getAttribLocation(this.program, 'a_position')
    this.texCoordAttributeLocation = gl.getAttribLocation(this.program, 'a_texCoord')
    this.textureUniformLocation = gl.getUniformLocation(this.program, 'u_texture')
    
    this.positionBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer)
    
    const positions = [-1, -1, 1, -1, -1, 1, 1, 1]
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW)
    
    this.texCoordBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer)
    
    const texCoords = [0, 1, 1, 1, 0, 0, 1, 0]
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(texCoords), gl.STATIC_DRAW)

    this.createReusableTextures()
  }

  createReusableTextures() {
    const gl = this.gl
    
    for (let i = 0; i < 4; i++) {
      const texture = gl.createTexture()

      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

      this.availableTextures.push(texture)
    }
  }

  getReusableTexture() {
    if (this.availableTextures.length > 0) {
      const texture = this.availableTextures.pop()
      this.usedTextures.add(texture)

      return texture
    }
    
    const gl = this.gl
    const texture = gl.createTexture()

    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    
    this.usedTextures.add(texture)

    return texture
  }

  returnReusableTexture(texture) {
    if (this.usedTextures.has(texture)) {
      this.usedTextures.delete(texture)

      if (this.availableTextures.length < 4) this.availableTextures.push(texture)
      else if (this.gl && this.gl.deleteTexture) this.gl.deleteTexture(texture)
    }
  }

  createShader(type, source) {
    const gl = this.gl
    const shader = gl.createShader(type)
    
    gl.shaderSource(shader, source)
    gl.compileShader(shader)

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader)
      
      return null
    }

    return shader
  }

  captureFrame(frameArrivalTime) {
    if (!this.video || this.video.readyState < 2) return null

    try {
      const gl = this.gl
      const texture = this.getReusableTexture()
      
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video)

      return Promise.resolve({
        texture: texture,
        timestamp: frameArrivalTime,
        frameNumber: this.frameCounter
      })
    } catch { 
      return Promise.resolve(null)
    }
  }

  async startDelayedVideo() {
    this.delayedVideoActive = true
    this.lastDrawnFrameTimestamp = 0
    this.stopFrameCounter = 0

    const renderLoop = async (timestamp) => {
      if (!this.delayedVideoActive) return

      requestAnimationFrame(renderLoop)

      if (this.timingMode === 'frame') this.checkFrameRate(timestamp)

      if (!this.visibleTab || this.lastFrameShown) return

      this.frameCounter++

      try {
        if (this.timingMode === 'time') {
          if (timestamp - this.videoStartTime < (this.delay + 17)) {
            this.drawWebGLFrame(this.initialFrame.texture)
          } else if (this.delayedFrame && this.delayedFrame.timestamp > this.lastDrawnFrameTimestamp - 34) {
            this.drawWebGLFrame(this.delayedFrame.texture)
            
            this.lastDrawnFrameTimestamp = this.delayedFrame.timestamp

            if (this.subtitleContext) {
              this.subtitleContext.clearRect(0, 0, this.subtitleCanvas.width, this.subtitleCanvas.height)
              this.renderSubtitles(this.subtitleCanvas.width, this.subtitleCanvas.height)
            }
          }
        } else {
          if (this.frameCounter - this.videoStartTime < (this.frameDelay + 1)) {
            this.drawWebGLFrame(this.initialFrame.texture)
          } else if (this.delayedFrame) {
            this.drawWebGLFrame(this.delayedFrame.texture)
            
            if (this.subtitleContext) {
              this.subtitleContext.clearRect(0, 0, this.subtitleCanvas.width, this.subtitleCanvas.height)
              this.renderSubtitles(this.subtitleCanvas.width, this.subtitleCanvas.height)
            }
          }
        }
      } catch {}

      if (this.video.ended) {
        if (this.timingMode === 'time' && !this.videoEnded) {
          this.videoEnded = true

          setTimeout(() => {
            if (this.video.ended && !this.lastFrameShown) {
              if (this.gl) this.gl.clear(this.gl.COLOR_BUFFER_BIT)
              if (this.subtitleContext) this.subtitleContext.clearRect(0, 0, this.subtitleCanvas.width, this.subtitleCanvas.height)
              
              this.lastFrameShown = true
            }
          }, this.delay + 34)
        } else if (this.timingMode === 'frame') {
          this.videoEnded = true
          this.stopFrameCounter++

          if (this.stopFrameCounter > this.frameDelay) {
            if (this.gl) this.gl.clear(this.gl.COLOR_BUFFER_BIT)
            if (this.subtitleContext) this.subtitleContext.clearRect(0, 0, this.subtitleCanvas.width, this.subtitleCanvas.height)
            
            this.lastFrameShown = true
          }
        }
      } else if (this.video.paused) {
        if (this.timingMode === 'time' && !this.videoPaused) {
          this.videoPaused = true

          setTimeout(() => { if (this.video.paused && !this.lastFrameShown) this.lastFrameShown = true }, this.delay)
        } else if (this.timingMode === 'frame') {
          this.stopFrameCounter++

          if (this.stopFrameCounter > this.frameDelay) this.lastFrameShown = true
        }
      }
    }

    this.initiationTime = performance.now()
    this.videoStartTime = this.frameCounter
    
    renderLoop()

    this.getFrameStates()
    this.captureFrameData()
  }

  getFrameStates() {
    const getFrameState = async () => {
      if (!this.delayedVideoActive) return

      if (this.videoEnded) this.restartDelayedVideo = true

      this.lastFrameShown = false
      this.videoPaused = false
      this.videoEnded = false
      this.stopFrameCounter = 0

      this.requestVideoAnimationFrame(getFrameState)
    }

    getFrameState()
  }

  requestVideoAnimationFrame(callback) {
    return this.video.requestVideoFrameCallback(callback)
  }

  async captureFrameData() {
    const captureFrameLoop = async () => {
      if (!this.delayedVideoActive) return
      
      requestAnimationFrame(captureFrameLoop)

      if (!this.visibleTab || this.video.paused || this.video.ended) return

      const frameArrivalTime = performance.now()
      const framePromise = await this.captureFrame(frameArrivalTime)

      if (!framePromise) return

      const frame = framePromise

      if (!frame || !frame.texture) return

      if (!this.initialFrame) {
        const initialTexture = this.getReusableTexture()

        this.gl.bindTexture(this.gl.TEXTURE_2D, initialTexture)
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.video)
        
        this.initialFrame = {
          texture: initialTexture,
          timestamp: frame.timestamp,
          frameNumber: frame.frameNumber
        }
      }

      if (this.restartDelayedVideo) {
        this.restartDelayedVideo = false
        
        if (this.initialFrame?.texture) this.returnReusableTexture(this.initialFrame.texture)
        
        const initialTexture = this.getReusableTexture()

        this.gl.bindTexture(this.gl.TEXTURE_2D, initialTexture)
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.video)
        
        this.initialFrame = {
          texture: initialTexture,
          timestamp: frame.timestamp,
          frameNumber: frame.frameNumber
        }

        if (this.timingMode === 'time') this.videoStartTime = performance.now()
        else this.videoStartTime = this.frameCounter
      }

      if (this.tabWasHidden) {
        this.tabWasHidden = false
        
        if (this.initialFrame?.texture) this.returnReusableTexture(this.initialFrame.texture)
        
        const initialTexture = this.getReusableTexture()

        this.gl.bindTexture(this.gl.TEXTURE_2D, initialTexture)
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.video)
        
        this.initialFrame = {
          texture: initialTexture,
          timestamp: frame.timestamp,
          frameNumber: frame.frameNumber
        }
        
        if (this.timingMode === 'time') this.videoStartTime = performance.now()
        else this.videoStartTime = this.frameCounter
      }

      this.currentFrame = frame

      this.scheduleFrameDelay()
      this.captureSubtitleData()
    }

    captureFrameLoop()
  }

  scheduleFrameDelay() {
    const currentFrame = this.currentFrame

    if (this.timingMode === 'time') {
      const adjustedDelay = this.delay - (performance.now() - currentFrame.timestamp) - 2

      const timeoutId = setTimeout(() => {
        if (!this.delayedVideoActive) return
        
        this.pendingTimeouts = this.pendingTimeouts.filter(id => id !== timeoutId)
        
        if (this.delayedFrame?.texture) this.returnReusableTexture(this.delayedFrame.texture)
        
        this.delayedFrame = currentFrame
      }, Math.max(0, adjustedDelay))
      
      this.pendingTimeouts.push(timeoutId)
    } else {
      const targetFrameNumber = this.frameCounter + this.frameDelay

      const delayLoop = () => {
        if (!this.delayedVideoActive) return
        
        if (this.frameCounter >= targetFrameNumber) {
          if (currentFrame.frameNumber <= (this.acceptFramesAfter || 0)) {
            this.returnReusableTexture(currentFrame.texture)

            return
          }
          
          if (this.delayedFrame?.texture) this.returnReusableTexture(this.delayedFrame.texture)
          
          this.delayedFrame = currentFrame
        } else {
          const rafId = requestAnimationFrame(delayLoop)
          this.pendingRAFs.push(rafId)
        }
      }

      const rafId = requestAnimationFrame(delayLoop)
      this.pendingRAFs.push(rafId)
    }
  }

  determineSubtitlePlayer() {
    const captionElements = document.querySelectorAll('[class*="caption"]')

    if (captionElements.length === 0) return false

    const visibleCaptions = Array.from(captionElements).filter(element => {
      const styles = window.getComputedStyle(element)
      
      return styles.display !== 'none' && styles.visibility !== 'hidden' && styles.opacity !== '0'
    })

    if (visibleCaptions.length === 0) return false

    const hasJwCaptions = visibleCaptions.some(element => element.innerHTML.trim().includes('jw-reset'))

    if (!hasJwCaptions) {
      this.hideSubtitlesStyle = document.createElement('style')
      this.hideSubtitlesStyle.textContent = '.ytp-caption-window-bottom, .ytp-caption-window-rollup { opacity: 0 !important; }'
      document.head.appendChild(this.hideSubtitlesStyle)

      return false
    }

    this.subtitleType = 'jwp'
    this.subtitleElements = Array.from(visibleCaptions)
    
    this.subtitleElements.forEach(element => {
      const originalStyles = {
        opacity: element.style.opacity,
        display: element.style.display
      }

      element.style.setProperty('opacity', '0', 'important')

      this.hiddenSubtitleElements.push({
        element: element,
        originalStyles: originalStyles
      })
    })

    return true
  }

  captureSubtitleData() {
    this.lines = []

    if (this.subtitleType === 'jwp') {
      this.subtitleElements.forEach(element => {
        const html = element.innerHTML.trim()

        if (html) this.parseJWSubtitles(html)
      })
    } else {
      const ytCaptionElements = document.querySelectorAll('.ytp-caption-window-bottom, .ytp-caption-window-rollup')
      
      if (ytCaptionElements.length > 0) {
        const captionsToCheck = Array.from(ytCaptionElements).filter(element => element.innerHTML.trim().length > 0)

        if (captionsToCheck.length > 0) {
          if (captionsToCheck.some(element => element.classList.contains('ytp-caption-window-rollup'))) {
            const ytElements = captionsToCheck.filter(element => element.classList.contains('ytp-caption-window-rollup'))
            
            this.parseYTSubtitles(ytElements, true)
          } else {
            this.parseYTSubtitles(captionsToCheck, false)
          }
        }
      }
    }

    this.scheduleSubtitleDelay()
  }

  parseJWSubtitles(html) {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    const spans = doc.querySelectorAll('.jw-text-track-cue')
    
    spans.forEach(span => {
      const text = span.textContent
      
      if (text) {
        const parsedSegments = this.parseStylizedJWSubtitles(text, true)
        
        parsedSegments.forEach(segment => { this.lines.push(segment) })
      }
    })
  }

  parseStylizedJWSubtitles(text, needsNewline) {
    let currentText = ''
    let segments = []

    let currentSegment = { 
      text: currentText,
      newline: needsNewline,
      styles: { bold: false, italic: false, underlined: false }
    }

    for (let i = 0; i < text.length; i++) {
      if (text[i] === '<') {
        if (text.substring(i, i+3) === '<b>' || text.substring(i, i+3) === '<i>' || text.substring(i, i+3) === '<u>') {
          if (currentText) {
            this.pushStylizedJWSubtitles(segments, currentText, needsNewline, currentSegment)
            
            currentText = ''
            needsNewline = false
          }

          if (text.substring(i, i+3) === '<b>') currentSegment.styles.bold = true
          else if (text.substring(i, i+3) === '<i>') currentSegment.styles.italic = true
          else if (text.substring(i, i+3) === '<u>') currentSegment.styles.underlined = true

          i += 2
        } else if (text.substring(i, i+4) === '</b>' || text.substring(i, i+4) === '</i>' || text.substring(i, i+4) === '</u>') {
          if (currentText) {
            this.pushStylizedJWSubtitles(segments, currentText, needsNewline, currentSegment)
            
            currentText = ''
            needsNewline = false
          }

          if (text.substring(i, i+4) === '</b>') currentSegment.styles.bold = false
          else if (text.substring(i, i+4) === '</i>') currentSegment.styles.italic = false
          else if (text.substring(i, i+4) === '</u>') currentSegment.styles.underlined = false

          i += 3
        } else {
          currentText += text[i]
        }
      } else if (text[i] === '\n') {
        if (currentText) {
          while (currentText[currentText.length - 1] === ' ') currentText = currentText.slice(0, -1)

          this.pushStylizedJWSubtitles(segments, currentText, needsNewline, currentSegment)
          
          currentText = ''
        }

        needsNewline = true
      } else {
        currentText += text[i]
      }
    }

    if (currentText) this.pushStylizedJWSubtitles(segments, currentText, needsNewline, currentSegment)

    return segments.filter(segment => segment.text.trim())
  }

  pushStylizedJWSubtitles(segments, currentText, needsNewline, currentSegment) {
    while (needsNewline && currentText[0] === ' ') currentText = currentText.slice(1)

    segments.push({
      text: currentText,
      newline: needsNewline,
      styles: {
        bold: currentSegment.styles.bold,
        italic: currentSegment.styles.italic,
        underlined: currentSegment.styles.underlined
      }
    })
  }

  parseYTSubtitles(ytElements, isAutogenerated) {   
    this.subtitleType = isAutogenerated ? 'ytp-auto' : 'ytp'
    
    ytElements.forEach(element => {
      const captionText = element.querySelector('.captions-text')

      if (!captionText) return
      
      const visualLines = captionText.querySelectorAll('.caption-visual-line')
      
      visualLines.forEach((visualLine, lineIndex) => {
        const segments = visualLine.querySelectorAll('.ytp-caption-segment')
        
        segments.forEach((segment, segmentIndex) => {
          const text = segment.textContent.trim()
          
          if (text) {
            this.lines.push({
              text: text,
              newline: segmentIndex === 0,
              styles: { bold: false, italic: false, underlined: false }
            })
          }
        })
      })
    })
    
    if (!isAutogenerated || this.lines.length === 0) return

    const logicalLines = []
    let currentLine = []
    
    this.lines.forEach(segment => {
      if (segment.newline) {
        if (currentLine.length > 0) logicalLines.push(currentLine)

        currentLine = [segment]
      } else {
        currentLine.push(segment)
      }
    })
    
    if (currentLine.length > 0) logicalLines.push(currentLine)
          
    this.lines = logicalLines.slice(-2).flat()
  }

  scheduleSubtitleDelay() {
    const currentSubtitleLines = this.lines

    if (this.timingMode === 'time') {
      setTimeout(() => { this.delayedSubtitleLines = currentSubtitleLines }, this.delay)
    } else {
      const currentFrameNumber = this.frameCounter
      
      const subtitleDelayLoop = () => {
        if (this.frameCounter - currentFrameNumber >= this.frameDelay) this.delayedSubtitleLines = currentSubtitleLines
        else requestAnimationFrame(subtitleDelayLoop)
      }
      
      requestAnimationFrame(subtitleDelayLoop)
    }
  }

  renderSubtitles(overlayWidth, overlayHeight) {
    if (this.delayedSubtitleLines.length === 0 || !this.subtitleContext) return

    const dpr = window.devicePixelRatio || 1
    
    this.subtitleContext.setTransform(1, 0, 0, 1, 0, 0)
    this.subtitleContext.scale(dpr, dpr)
    this.subtitleContext.imageSmoothingEnabled = false
    this.subtitleContext.save()
    
    const adjustedWidth = overlayWidth / dpr
    const adjustedHeight = overlayHeight / dpr
    const baselineY = Math.round(adjustedHeight * 0.865)
    const fontSize = Math.max(12, Math.round(adjustedHeight * 0.04))
    const padding = Math.round(fontSize * 0.3)
    const lineSpacing = Math.round((fontSize + padding) * 1.13)
    
    this.subtitleContext.textAlign = 'center'
    this.subtitleContext.textBaseline = 'middle'
    this.subtitleContext.fontKerning = 'normal'
    this.subtitleContext.textRendering = 'geometricPrecision'
    
    const bgColor = 'rgba(0, 0, 0, 0.55)'
    const textColor = 'rgb(255, 255, 255)'
    const logicalLines = []
    
    let currentLine = []

    this.delayedSubtitleLines.forEach(segment => {
      if (segment.newline) {
        currentLine = [segment]
        
        logicalLines.push(currentLine)
      } else {
        if (currentLine.length === 0) {
          currentLine = [segment]
          
          logicalLines.push(currentLine)
        } else {
          currentLine.push(segment)
        }
      }
    })

    const totalLogicalLines = logicalLines.length
    const verticalPositions = Array(totalLogicalLines).fill(0).map((_, i) => Math.round(baselineY - (totalLogicalLines - 1 - i) * lineSpacing))

    logicalLines.forEach((lineSegments, lineIndex) => {
      const lineY = verticalPositions[lineIndex]
      
      let totalLineWidth = 0
      const segmentWidths = []

      lineSegments.forEach(segment => {
        let fontStyle = ''

        if (segment.styles.italic) fontStyle += 'italic '
        if (segment.styles.bold) fontStyle += 'bold '

        this.subtitleContext.font = `${fontStyle}${fontSize}px Helvetica, sans-serif`
        
        const textMetrics = this.subtitleContext.measureText(segment.text)
        const segmentWidth = Math.round(textMetrics.width)
        
        segmentWidths.push(segmentWidth)
        
        totalLineWidth += segmentWidth
      })

      let rectX, currentX

      if (this.subtitleType === 'ytp-auto') {
        rectX = Math.round(adjustedWidth * 0.25 * (fontSize === 12 ? 0.4 : 1))
        currentX = rectX + padding
      } else {
        rectX = Math.round(adjustedWidth / 2 - totalLineWidth / 2 - padding)
        currentX = adjustedWidth / 2 - totalLineWidth / 2
      }

      const rectY = Math.round(lineY - fontSize / 2 - padding / 2)
      const rectWidth = Math.round(totalLineWidth + padding * 2)
      const rectHeight = Math.round(fontSize + padding)
      
      this.subtitleContext.fillStyle = bgColor
      this.subtitleContext.fillRect(rectX, rectY, rectWidth, rectHeight)

      lineSegments.forEach((segment, segmentIndex) => {
        const segmentText = segment.text
        const segmentWidth = segmentWidths[segmentIndex]
        
        let fontStyle = ''

        if (segment.styles.italic) fontStyle += 'italic '
        if (segment.styles.bold) fontStyle += 'bold '

        this.subtitleContext.font = `${fontStyle}${fontSize}px Helvetica, sans-serif`
        this.subtitleContext.textAlign = 'left'
        this.subtitleContext.fillStyle = textColor
        this.subtitleContext.fillText(segmentText, Math.round(currentX), lineY + 0.0025 * adjustedHeight)

        if (segment.styles.underlined) {
          this.subtitleContext.beginPath()
          
          const underlineY = Math.round(lineY + fontSize * 0.34)
          
          this.subtitleContext.moveTo(Math.round(currentX), underlineY)
          this.subtitleContext.lineTo(Math.round(currentX + segmentWidth), underlineY)
          this.subtitleContext.lineWidth = Math.max(1, Math.round(fontSize * 0.05))
          this.subtitleContext.strokeStyle = textColor
          this.subtitleContext.stroke()
        }

        currentX += segmentWidth
      })

      this.subtitleContext.textAlign = 'center'
    })

    this.subtitleContext.restore()
  }

  updateDelayedVideo(newDelay) {
    this.originalDelay = newDelay

    if (this.timingMode === 'time') {
      this.delay = newDelay
    } else {
      const newFrameDelay = Math.max(Math.round(newDelay / 16.67) - 1, 0)
      const oldDelay = this.frameDelay
      
      this.frameDelay = newFrameDelay
      
      if (newFrameDelay < oldDelay) this.acceptFramesAfter = this.frameCounter + newFrameDelay
    }
  }

  cleanupTextures() {
    if (!this.gl) return

    this.pendingTimeouts.forEach(timeoutId => clearTimeout(timeoutId))
    this.pendingTimeouts = []

    this.pendingRAFs.forEach(rafId => cancelAnimationFrame(rafId))
    this.pendingRAFs = []

    try {
      if (this.currentFrame && this.currentFrame.texture) {
        this.gl.deleteTexture(this.currentFrame.texture)
        this.usedTextures.delete(this.currentFrame.texture)
      }

      if (this.delayedFrame && this.delayedFrame.texture) {
        this.gl.deleteTexture(this.delayedFrame.texture)
        this.usedTextures.delete(this.delayedFrame.texture)
      }

      if (this.initialFrame && this.initialFrame.texture) {
        this.gl.deleteTexture(this.initialFrame.texture)
        this.usedTextures.delete(this.initialFrame.texture)
      }

      this.availableTextures.forEach(texture => { if (this.gl.isTexture(texture)) this.gl.deleteTexture(texture) })
      this.usedTextures.forEach(texture => { if (this.gl.isTexture(texture)) this.gl.deleteTexture(texture) })

      this.availableTextures = []
      this.usedTextures.clear()
      this.currentFrame = null
      this.delayedFrame = null
      this.initialFrame = null
    } catch {}
  }

  stopDelayedVideo() {
    this.delayedVideoActive = false
    
    this.pendingTimeouts.forEach(timeoutId => clearTimeout(timeoutId))
    this.pendingTimeouts = []

    this.pendingRAFs.forEach(rafId => cancelAnimationFrame(rafId))
    this.pendingRAFs = []
    
    if (this.videoFrameCallbacks) this.videoFrameCallbacks = null

    if (this.video) {
      this.video.removeEventListener('emptied', this.videoEmptiedHandler)
      this.video.style.setProperty('opacity', '1', 'important')
      setTimeout(() => { this.video.style.setProperty('opacity', '1', 'important') }, 17)
    }

    if (this.visibilityChangeHandler) {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler)
      this.visibilityChangeHandler = null
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }

    if (this.hiddenSubtitleElements && this.hiddenSubtitleElements.length > 0) {
      this.hiddenSubtitleElements.forEach(item => {
        if (item.element) {
          item.element.style.removeProperty('opacity')

          if (item.originalStyles) {
            Object.entries(item.originalStyles).forEach(([prop, value]) => {
              if (value !== undefined && value !== null) item.element.style[prop] = value
            })
          }
        }
      })

      this.hiddenSubtitleElements = []
    }

    if (this.hideSubtitlesStyle && this.hideSubtitlesStyle.parentNode) {
      this.hideSubtitlesStyle.parentNode.removeChild(this.hideSubtitlesStyle)
      this.hideSubtitlesStyle = null
    }

    this.subtitleElements = []
    this.delayedSubtitleLines = []

    if (this.videoCanvas && this.videoCanvas.parentNode) this.videoCanvas.parentNode.removeChild(this.videoCanvas)
    if (this.subtitleCanvas && this.subtitleCanvas.parentNode) this.subtitleCanvas.parentNode.removeChild(this.subtitleCanvas)

    this.videoCanvas = null
    this.subtitleCanvas = null
    this.subtitleContext = null

    setTimeout(() => {
      if (this.gl) {
        this.availableTextures.forEach(texture => { if (this.gl.isTexture(texture)) this.gl.deleteTexture(texture) })
        this.usedTextures.forEach(texture => { if (this.gl.isTexture(texture)) this.gl.deleteTexture(texture) })

        if (this.program) {
          const shaders = this.gl.getAttachedShaders(this.program)

          if (shaders) {
            shaders.forEach(shader => {
              this.gl.detachShader(this.program, shader)
              this.gl.deleteShader(shader)
            })
          }

          this.gl.deleteProgram(this.program)
        }

        if (this.positionBuffer) this.gl.deleteBuffer(this.positionBuffer)
        if (this.texCoordBuffer) this.gl.deleteBuffer(this.texCoordBuffer)

        const loseContext = this.gl.getExtension('WEBGL_lose_context')

        if (loseContext) loseContext.loseContext()
      }

      this.availableTextures = []
      this.usedTextures.clear()
      this.currentFrame = null
      this.delayedFrame = null
      this.initialFrame = null
      this.gl = null
      this.program = null
      this.positionBuffer = null
      this.texCoordBuffer = null
    }, 34)
  }
}

class DelayedAudio {
  constructor(delay) {
    this.delay = Math.min(delay, 120000) / 1000
    this.isActive = true
    this.audioSources = new Map()
    this.processedElements = new Set()
    
    this.startDelayedAudio()
  }

  startDelayedAudio() {
    this.processExistingElements()

    this.observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === 1) {
            if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO') this.processElement(node)
            if (node.querySelectorAll) node.querySelectorAll('audio, video').forEach(element => { this.processElement(element) })
          }
        })
      })
    })

    this.observer.observe(document.documentElement, { childList: true, subtree: true })
  }

  processExistingElements() {
    document.querySelectorAll('audio, video').forEach(element => { this.processElement(element) })
  }

  processElement(element) {
    if (this.audioSources.has(element)) {
      this.updateElementDelay(element)
      
      return
    }

    if (this.processedElements.has(element)) return

    this.processedElements.add(element)

    const setupElement = () => {
      try {
        const context = new AudioContext()
        const source = context.createMediaElementSource(element)
        const delayNode = context.createDelay(120)
        const gainNode = context.createGain()
        const bypassGain = context.createGain()
        
        source.connect(gainNode)
        source.connect(bypassGain)
        gainNode.connect(delayNode)
        delayNode.connect(context.destination)
        bypassGain.connect(context.destination)

        this.audioSources.set(element, {
          context: context,
          source: source,
          delayNode: delayNode,
          gainNode: gainNode,
          bypassGain: bypassGain
        })

        this.updateElementDelay(element)

        if (context.state === 'suspended') {
          const resume = () => {
            context.resume()
            
            element.removeEventListener('play', resume)
            element.removeEventListener('canplay', resume)
          }

          element.addEventListener('play', resume)
          element.addEventListener('canplay', resume)
        }
      } catch {}
    }

    if (element.readyState >= 1) setupElement()
    else element.addEventListener('loadedmetadata', setupElement, { once: true })
  }

  updateElementDelay(element) {
    const audioData = this.audioSources.get(element)

    if (!audioData) return

    const { context, gainNode, bypassGain } = audioData

    if (this.delay > 0) {
      audioData.delayNode.delayTime.value = this.delay
      gainNode.gain.value = 1.0
      bypassGain.gain.value = 0.0
    } else {
      gainNode.gain.value = 0.0

      try {
        audioData.delayNode.disconnect()
        gainNode.disconnect()
        
        const newDelayNode = context.createDelay(120)
        newDelayNode.delayTime.value = 0
        
        gainNode.connect(newDelayNode)
        newDelayNode.connect(context.destination)
        
        audioData.delayNode = newDelayNode
      } catch {}

      bypassGain.gain.value = 1.0
    }
  }

  updateDelayedAudio(delay, restart) {
    this.delay = Math.min(delay, 120000) / 1000
    
    this.audioSources.forEach((audioData, element) => { this.updateElementDelay(element) })
    
    if (restart) this.processExistingElements()
  }

  stopDelayedAudio() {
    this.delay = 0
    
    this.audioSources.forEach((audioData, element) => { this.updateElementDelay(element) })
  }
}

const monitor = new Monitor()