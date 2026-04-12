# GRE Vocabulary Flash Cards (Android)

A modern black-and-white GRE vocabulary flashcard app inspired by Magoosh, built with React Native (Expo).

## Data source

The app fetches words with the Fetch API from:

`https://raw.githubusercontent.com/iMahir/gre-vocab-app/refs/heads/main/GRE_Words.json`

## Features

- Deck/group selection from GRE word groups
- Tap card to reveal definition, example, mnemonic, and synonyms
- Mark words as **Mastered**, **Reviewing**, or **Learning**
- Progress bars per deck for all three learning states
- Pronunciation audio playback
- Local progress persistence with AsyncStorage
- Black-and-white UI with Poppins typography

## Run locally

```bash
npm install
npm run start
```

To open Android emulator/device:

```bash
npm run android
```

## Android release automation

The workflow at `.github/workflows/android-release.yml` builds an Android APK and publishes it to GitHub Releases:

- Automatically on tags like `v1.0.0`
- Manually via **Actions → Android Release → Run workflow**
