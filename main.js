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

        if (result.mode == 'Video' && result.enabled) {
          this.setupVideoListeners()
        } else if (result.mode == 'Audio' && result.enabled) {
          if (!this.delayedAudio) this.delayedAudio = new DelayedAudio(this.delay)
          else this.delayedAudio.updateDelayedAudio(this.delay, true)
        } else if (this.delayedAudio) {
          this.delayedAudio.stopDelayedAudio()
        }
      })

      chrome.runtime.onMessage.addListener((message) => {
        if (message.type == 'setDelay') {
          chrome.storage.local.get(['mode', 'enabled'], (result) => {
            this.delay = message.delay
            this.mode = result.mode
            this.enabled = result.enabled

            this.stopVideoDelay(false, null)

            if (this.delayedAudio) this.delayedAudio.stopDelayedAudio()

            if (result.enabled && result.mode == 'Video') {
              this.setupVideoListeners()
            } else if (result.enabled && result.mode == 'Audio') {
              if (!this.delayedAudio) this.delayedAudio = new DelayedAudio(this.delay)
              else this.delayedAudio.updateDelayedAudio(this.delay, true)
            }
          })
        } else if (message.type == 'updateDelay') {
          chrome.storage.local.get(['mode', 'enabled'], (result) => {
            this.delay = message.delay

            if (!result.enabled) {
              this.stopVideoDelay(false, null)

              if (this.delayedAudio) this.delayedAudio.stopDelayedAudio()
            } else if (result.mode == 'Video') {
              this.delayedVideos.forEach((delayedVideo) => { delayedVideo.updateDelayedVideo(this.delay) })
            } else if (this.delayedAudio) {
              this.delayedAudio.updateDelayedAudio(this.delay, false)
            }
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
          if (node.tagName == 'VIDEO') this.waitForVideoFrameRefresh(node)
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
    if (video.closest('.video-delay-container') || video.closest('.video-delay-container-relative') ||
        this.videoCallbacks.has(video) || this.delayedVideos.has(video)) {
      return
    }

    const requestFrameCallback = () => {
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        const callbackId = video.requestVideoFrameCallback((now, metadata) => {
          this.videoCallbacks.delete(video)

          this.processVideo(video)
        })

        this.videoCallbacks.set(video, callbackId)
      }
    }

    requestFrameCallback()

    const onPlay = () => { if (!this.videoCallbacks.has(video) && !this.delayedVideos.has(video)) requestFrameCallback() }
    
    video.addEventListener('play', onPlay)
    video.addEventListener('loadstart', onPlay)
  }

  processVideo(video) {
    if (!this.enabled || this.mode != 'Video' ||
        video.closest('.video-delay-container') || video.closest('.video-delay-container-relative')) {
      return
    }

    const delayedVideo = new DelayedVideo(video, this.delay)
    
    this.delayedVideos.set(video, delayedVideo)
  }

  stopVideoDelay(startNewMonitor, specificVideo) {
    this.clearVideoCallbacks()
    
    if (this.observer) {
      this.observer.disconnect()
      this.observer = null
    }

    if (specificVideo) {
      const delayedVideo = this.delayedVideos.get(specificVideo)
      
      if (delayedVideo) {
        delayedVideo.stopDelayedVideo()

        this.delayedVideos.delete(specificVideo)
      }
    } else {
      this.delayedVideos.forEach((delayedVideo) => { delayedVideo.stopDelayedVideo() })
      this.delayedVideos.clear()
    }

    if (startNewMonitor) this.startMonitor()
  }
}

class DelayedVideo {
  constructor(video, delay) {
    this.video = video
    this.delay = delay

    this.frameQueue = []
    this.subtitleElements = []
    this.hiddenSubtitleElements = []
    this.currentSubtitleLines = []
    this.delayedSubtitleLines = []

    this.visibleTab = !document.hidden
    this.tabWasHidden = false
    this.videoEnded = false
    this.lastFrameShown = false
    this.restartDelayedVideo = false

    this.addEventListeners()
    this.createCanvases()
    this.trackSubtitles()
    this.startDelayedVideo()
  }

  addEventListeners() {
    this.video.addEventListener('resize', () => { this.updateCanvasDimensions() })
    
    this.resizeObserver = new ResizeObserver(() => { this.updateCanvasDimensions() })
    this.resizeObserver.observe(this.video)
    
    this.videoEmptiedHandler = () => { monitor.stopVideoDelay(true, this.video) }
    
    this.video.addEventListener('emptied', this.videoEmptiedHandler)

    this.visibilityChangeHandler = () => {
      this.visibleTab = !document.hidden
      
      if (this.visibleTab) this.videoStartTime = performance.now()
      else this.tabWasHidden = true
    }

    document.addEventListener('visibilitychange', this.visibilityChangeHandler)
  }

  updateCanvasDimensions() {
    if (!this.videoCanvas || !this.video) return

    const videoStyle = window.getComputedStyle(this.video)
    
    this.videoCanvas.width = this.video.videoWidth
    this.videoCanvas.height = this.video.videoHeight
    
    if (this.gl) this.gl.viewport(0, 0, this.videoCanvas.width, this.videoCanvas.height)

    this.videoCanvas.style.position = videoStyle.position
    this.videoCanvas.style.top = videoStyle.top
    this.videoCanvas.style.left = videoStyle.left
    this.videoCanvas.style.width = videoStyle.width
    this.videoCanvas.style.height = videoStyle.height
    this.videoCanvas.style.transform = videoStyle.transform
    
    const videoRect = this.video.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    
    this.subtitleCanvas.width = videoRect.width * dpr
    this.subtitleCanvas.height = videoRect.height * dpr
    
    if (this.subtitleContext) {
      this.subtitleContext.setTransform(1, 0, 0, 1, 0, 0)
      this.subtitleContext.scale(dpr, dpr)
      this.subtitleContext.imageSmoothingEnabled = false
    }

    this.subtitleCanvas.style.position = videoStyle.position
    this.subtitleCanvas.style.top = videoStyle.top
    this.subtitleCanvas.style.left = videoStyle.left
    this.subtitleCanvas.style.width = videoStyle.width
    this.subtitleCanvas.style.height = videoStyle.height
    this.subtitleCanvas.style.transform = videoStyle.transform

    try { this.drawWebGLFrame(this.delayedFrame.texture) } catch {}
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

    if (!this.video.ended) {
      const framePromise = await this.captureFrame()

      if (framePromise) {
        const frame = framePromise
        
        try { this.drawWebGLFrame(frame.texture) } catch {}
      }
    }

    setTimeout(() => { this.video.style.setProperty('opacity', '0', 'important') }, 17)
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

  captureFrame() {
    if (!this.video || this.video.readyState < 2) return null

    const captureTimestamp = performance.now()

    try {
      const gl = this.gl
      const texture = gl.createTexture()
      
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video)

      return Promise.resolve({
        texture: texture,
        timestamp: captureTimestamp
      })
    } catch { 
      return Promise.resolve(null)
    }
  }

  trackSubtitles() {
    const captionElements = document.querySelectorAll('[class*="caption"]')

    if (captionElements.length > 0) {
      const visibleCaptions = Array.from(captionElements).filter(element => {
        const styles = window.getComputedStyle(element)

        return styles.display != 'none' && styles.visibility != 'hidden' && styles.opacity != '0'
      })

      const hasJwCaptions = visibleCaptions.some(element => element.innerHTML.trim().includes('jw-reset'))

      if (!hasJwCaptions) return false

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

    return false
  }

  async startDelayedVideo() {
    this.delayedVideoActive = true
    this.lastDrawnFrameTimestamp = 0

    const renderLoop = async (timestamp) => {
      if (!this.delayedVideoActive) return

      requestAnimationFrame(renderLoop)

      if (this.visibleTab) {
        try {
          if (timestamp - this.videoStartTime <= this.delay) {
            if (!this.lastFrameShown) this.drawWebGLFrame(this.initialFrame.texture)
          } else {
            if (!this.lastFrameShown) {
              if (this.delayedFrame && this.delayedFrame.timestamp > this.lastDrawnFrameTimestamp - 34) {
                this.drawWebGLFrame(this.delayedFrame.texture)
                
                this.lastDrawnFrameTimestamp = this.delayedFrame.timestamp

                if (this.subtitleContext) {
                  this.subtitleContext.clearRect(0, 0, this.subtitleCanvas.width, this.subtitleCanvas.height)
                  
                  this.renderSubtitles(this.subtitleCanvas.width, this.subtitleCanvas.height)
                }
              }
            }
          }
        } catch {}
      }

      if (this.video.ended && !this.videoEnded) {
        this.videoEnded = true

        setTimeout(() => {
          if (this.video.ended && !this.lastFrameShown) {
            if (this.gl && this.videoCanvas) this.gl.clear(this.gl.COLOR_BUFFER_BIT)
            if (this.subtitleContext) this.subtitleContext.clearRect(0, 0, this.subtitleCanvas.width, this.subtitleCanvas.height)
            
            try { this.gl.deleteTexture(this.currentFrame.texture) } catch {}
            try { this.gl.deleteTexture(this.delayedFrame.texture) } catch {}

            this.lastFrameShown = true
          }
        }, this.delay)
      }

      if (this.video.paused && !this.videoPaused) {
        this.videoPaused = true

        setTimeout(() => { if (this.video.paused && !this.lastFrameShown) this.lastFrameShown = true }, this.delay)
      }
    }

    this.videoStartTime = performance.now()
    
    renderLoop()

    this.getFrameStates()
    this.captureFrameData()
    this.captureSubtitleData()
  }

  renderSubtitles(overlayWidth, overlayHeight) {
    if (this.delayedSubtitleLines.length == 0 || !this.subtitleContext) return

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
    
    const bgColor = 'rgba(0, 0, 0, 0.5)'
    const textColor = 'rgb(255, 255, 255)'
    const logicalLines = []
    
    let currentLine = []

    this.delayedSubtitleLines.forEach(segment => {
      if (segment.newline) {
        currentLine = [segment]
        
        logicalLines.push(currentLine)
      } else {
        if (currentLine.length == 0) {
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

      const rectX = Math.round(adjustedWidth / 2 - totalLineWidth / 2 - padding)
      const rectY = Math.round(lineY - fontSize / 2 - padding / 2)
      const rectWidth = Math.round(totalLineWidth + padding * 2)
      const rectHeight = Math.round(fontSize + padding)
      
      this.subtitleContext.fillStyle = bgColor
      this.subtitleContext.fillRect(rectX, rectY, rectWidth, rectHeight)
      
      let currentX = adjustedWidth / 2 - totalLineWidth / 2

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

  getFrameStates() {
    const getFrameState = async () => {
      if (!this.delayedVideoActive) return

      if (this.videoPaused) {
        this.videoPaused = false
        this.lastFrameShown = false
      }

      if (this.videoEnded) {
        this.updateCanvasDimensions()
        
        this.videoEnded = false
        this.lastFrameShown = false
        this.restartDelayedVideo = true
      }

      this.requestVideoAnimationFrame(getFrameState)
    }

    getFrameState()
  }

  requestVideoAnimationFrame(callback) {
    return this.video.requestVideoFrameCallback(callback)
  }

  captureFrameData() {
    const captureFrames = async () => {
      if (!this.delayedVideoActive) return

      requestAnimationFrame(captureFrames)

      if (!this.visibleTab || this.videoPaused || this.videoEnded) return

      const framePromise = await this.captureFrame()

      if (framePromise) {
        const frame = framePromise

        if (frame && frame.texture) {
          if (!this.initialFrame) {
            this.updateCanvasDimensions()
            
            this.initialFrame = frame
            this.videoStartTime = performance.now()
          }

          if (this.restartDelayedVideo) {
            this.restartDelayedVideo = false
            this.initialFrame = frame
            this.videoStartTime = performance.now()
          }

          if (this.tabWasHidden) {
            this.tabWasHidden = false
            this.initialFrame = frame
            
            setTimeout(() => { this.videoStartTime = performance.now() }, 17)
          }

          this.currentFrame = frame
          
          this.scheduleFrameDelay()
        }
      }
    }
  
    captureFrames()
  }

  scheduleFrameDelay() {
    const currentFrame = this.currentFrame

    setTimeout(() => {
      try { this.gl.deleteTexture(this.delayedFrame.texture) } catch {}

      this.delayedFrame = currentFrame
    }, this.delay)
  }

  captureSubtitleData() {
    const captureSubtitles = () => {
      if (!this.delayedVideoActive) return

      requestAnimationFrame(captureSubtitles)

      if (!this.visibleTab || this.videoPaused || this.videoEnded) return

      let lines = []
      let elementIndex = 0

      this.subtitleElements.forEach(element => {
        const html = element.innerHTML.trim()

        if (html) {
          let startIndex = 0

          while (true) {
            startIndex = html.indexOf('plaintext;">', startIndex)

            if (startIndex == -1) break

            startIndex += 'plaintext;">'.length
            
            const endIndex = html.indexOf('</div>', startIndex)

            if (endIndex == -1) break

            let text = html.substring(startIndex, endIndex)

            if (text.includes('&amp;')) text = text.replace(/&amp;/g, '&')

            if (text.match(/<[biu]>/)) {
              const parsedSegments = this.parseStyledText(text, elementIndex > 0)
              
              lines = lines.concat(parsedSegments)
            } else {
              text.split('\n').forEach(line => {
                if (line.trim()) {
                  lines.push({ 
                    text: line.trim(),
                    newline: true,
                    styles: { bold: false, italic: false, underlined: false }
                  })
                }
              })
            }

            startIndex = endIndex
            elementIndex++
          }
        }
      })

      this.currentSubtitleLines = lines
      
      this.scheduleSubtitleDelay()
    }

    captureSubtitles()
  }

  parseStyledText(text, needsNewline) {
    let currentText = ''
    let segments = []

    let currentSegment = { 
      text: currentText,
      newline: needsNewline,
      styles: { bold: false, italic: false, underlined: false }
    }

    for (let i = 0; i < text.length; i++) {
      if (text[i] == '<') {
        if (text.substring(i, i+3) == '<b>' || text.substring(i, i+3) == '<i>' || text.substring(i, i+3) == '<u>') {
          if (currentText) {
            this.pushSegments(segments, currentText, needsNewline, currentSegment)
            
            currentText = ''
            needsNewline = false
          }

          if (text.substring(i, i+3) == '<b>') currentSegment.styles.bold = true
          else if (text.substring(i, i+3) == '<i>') currentSegment.styles.italic = true
          else if (text.substring(i, i+3) == '<u>') currentSegment.styles.underlined = true

          i += 2
        } else if (text.substring(i, i+4) == '</b>' || text.substring(i, i+4) == '</i>' || text.substring(i, i+4) == '</u>') {
          if (currentText) {
            this.pushSegments(segments, currentText, needsNewline, currentSegment)
            
            currentText = ''
            needsNewline = false
          }

          if (text.substring(i, i+4) == '</b>') currentSegment.styles.bold = false
          else if (text.substring(i, i+4) == '</i>') currentSegment.styles.italic = false
          else if (text.substring(i, i+4) == '</u>') currentSegment.styles.underlined = false

          i += 3
        } else {
          currentText += text[i]
        }
      } else if (text[i] == '\n') {
        if (currentText) {
          while (currentText[currentText.length - 1] == ' ') currentText = currentText.slice(0, -1)

          this.pushSegments(segments, currentText, needsNewline, currentSegment)
          
          currentText = ''
        }

        needsNewline = true
      } else {
        currentText += text[i]
      }
    }

    if (currentText) this.pushSegments(segments, currentText, needsNewline, currentSegment)

    return segments.filter(segment => segment.text.trim())
  }

  pushSegments(segments, currentText, needsNewline, currentSegment) {
    while (needsNewline && currentText[0] == ' ') currentText = currentText.slice(1)

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

  scheduleSubtitleDelay() {
    const currentSubtitleLines = this.currentSubtitleLines
    
    setTimeout(() => { this.delayedSubtitleLines = currentSubtitleLines }, this.delay)
  }

  updateDelayedVideo(newDelay) {
    this.delay = newDelay
  }

  stopDelayedVideo() {
    this.delayedVideoActive = false
    
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
              if (value != undefined && value != null) item.element.style[prop] = value
            })
          }
        }
      })

      this.hiddenSubtitleElements = []
    }

    this.subtitleElements = []
    this.currentSubtitleLines = []
    this.delayedSubtitleLines = []

    if (this.videoCanvas && this.videoCanvas.parentNode) this.videoCanvas.parentNode.removeChild(this.videoCanvas)
    if (this.subtitleCanvas && this.subtitleCanvas.parentNode) this.subtitleCanvas.parentNode.removeChild(this.subtitleCanvas)

    this.videoCanvas = null
    this.subtitleCanvas = null
    this.subtitleContext = null

    setTimeout(() => {
      if (this.gl) {
        try { if (this.currentFrame && this.currentFrame.texture) this.gl.deleteTexture(this.currentFrame.texture) } catch {}
        try { if (this.delayedFrame && this.delayedFrame.texture) this.gl.deleteTexture(this.delayedFrame.texture) } catch {}
        try { if (this.initialFrame && this.initialFrame.texture) this.gl.deleteTexture(this.initialFrame.texture) } catch {}

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
          if (node.nodeType == 1) {
            if (node.tagName == 'AUDIO' || node.tagName == 'VIDEO') this.processElement(node)
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

        if (context.state == 'suspended') {
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