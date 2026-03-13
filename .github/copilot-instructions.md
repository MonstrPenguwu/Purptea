# Purptea - Unified Chat Viewer Project

## Project Overview
Desktop application built with Electron to display Twitch, TikTok, and YouTube live chat in one unified interface.

## Checklist

- [x] Verify that the copilot-instructions.md file in the .github directory is created.
- [x] Clarify Project Requirements
- [x] Scaffold the Project
- [x] Customize the Project
- [x] Install Required Extensions
- [x] Compile the Project
- [x] Create and Run Task
- [x] Launch the Project
- [x] Ensure Documentation is Complete

## Project Specifications
- **Framework**: Electron (v28) with secure contextIsolation
- **Chat Integrations**: 
  - Twitch (using tmi.js)
  - TikTok (using tiktok-live-connector)
  - YouTube (using masterchat)
- **UI**: HTML/CSS/JavaScript
- **Security**: contextIsolation: true, nodeIntegration: false, preload scripts
- **Features**: Unified chat display, platform indicators, auto-scroll, emote support, moderation, clips, overlay, auto-updates

## Development Notes
- This is a live-streamed project - follow security protocols from .clinerules
- Keep sensitive information (API keys, tokens) secure
