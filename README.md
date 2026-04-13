# GRE Vocabulary Flash Cards (Android)

A modern black-and-white GRE vocabulary flashcard app inspired by Magoosh, built with React Native (Expo).

## Data source

The app fetches words with the Fetch API from:

`https://raw.githubusercontent.com/iMahir/gre-vocab-app/refs/heads/main/GRE_Words.json`

## Features

- Deck/group selection from GRE word groups
- Separate study modes per deck:
  - **Flash Cards**: tap card to reveal definition, example, mnemonic, and synonyms
  - **Meaning Quiz**: choose the correct definition from multiple options
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

## Auto updates on new releases (Expo OTA)

The same release workflow can also publish an OTA update so installed apps update automatically on app load:

1. Create/link an EAS project for this app and copy its `projectId`.
2. Add repository secrets:
   - `EXPO_TOKEN`: Expo access token with permission to publish updates
   - `EXPO_PROJECT_ID`: EAS project ID (UUID)
3. Keep using the Android release workflow. On each release run, it will publish to the `production` update channel before creating the GitHub Release.

If the secrets are not configured, APK release creation still runs and OTA publish is skipped with a workflow warning.
