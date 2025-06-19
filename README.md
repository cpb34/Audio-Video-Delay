# Audio/Video Delay

Chrome extension that seamlessly delays audio and DRM-free video

## Usage
Toggle between delaying audio and video by clicking the red/yellow `Audio/Video` text at the top of the GUI. Input the desired delay in milliseconds and press the bottom button to enable and disable the delay.

## Installation Guide

### Chrome Web Store:
*Audio/Video Delay* is available on the Chrome Web Store and can be installed like any other extension

### Load Unpacked:
*Audio/Video Delay* can be loaded into the browser with the following steps:
1. Download and unzip `Audio-Video-Delay-2.1.0` from the latest GitHub release
2. Visit the browser extensions page and turn on Developer mode
3. Click "Load unpacked"
4. Select the unzipped folder

### Optional Font Download for Arch Linux:
This extension uses the Courier New and Brush Script MT fonts, which do not come standard on Linux. Use command `yay -S ttf-ms-fonts` to obtain these from the AUR.

## Release Notes

**v2.1.0** - Rewritten to remove fullscreen limitation, GUI behavior modifications

**v2.0.0** - Audio delay implemented, GUI update, filename changes, subtitle bug fix

**v1.2.1** - Subtitle logic changed to allow multiple styles per line

**v1.2.0** - Better render efficiency and subtitle clarity at low resolutions

**v1.1.2** - Subtitle bug fix

**v1.1.1** - Chrome storage bug fix

**v1.1.0** - Subtitle delay support implemented for videos using the JW Player

**v1.0.0** - Video delay and UI foundation

## Limitations

- Video delay feature is not supported with DRM-protected content
- Subtitle delay feature is only supported for videos using the JW Player

## Contributions

If this extension provides you value, please consider starring the GitHub repository, leaving a Google review, or donating to my [PayPal](https://paypal.me/paypalcpb). If you would like to contribute to the code, I welcome you to do so! Thank you!