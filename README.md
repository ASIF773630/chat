# ConnectX random chat MVP

This project includes an Expo React Native app and a small WebSocket matchmaking/signaling server. It supports country/interest matching, text chat, reporting/leaving, and peer-to-peer voice/video calls.

## Run locally

1. Install the app dependencies from this folder:

   ```sh
   npm install
   ```

2. In a second terminal, install and start the match server:

   ```sh
   npm --prefix server install
   npm run server
   ```

3. Start the app:

   ```sh
   npm start
   ```

   The app defaults to `ws://10.0.2.2:3001` on Android emulators and `ws://localhost:3001` elsewhere. On a physical phone, enter the computer's LAN address, for example `ws://192.168.1.20:3001`. Both users must connect to the same server.

4. Voice/video requires native WebRTC code. Expo Go is not supported. Generate a development build with `npm run prebuild` and then `npm run android` (Android Studio/SDK required). iOS native builds require macOS and Xcode.

## Free-tier and safety limits

The server does not store accounts or chat messages. The included report handler only logs anonymous session IDs to the server console; it is not a moderation system. This is a prototype, not ready for public use: add age controls, moderation, blocking, abuse handling, and privacy/legal disclosures before opening it to strangers. Keep the server behind HTTPS/WSS in public deployments and add authentication and operational protections.

Voice/video uses a public STUN server for peer-to-peer connections. Some networks require a TURN relay; reliable TURN service may not be free. Free hosting and free-tier quotas are not guaranteed as usage grows.
