const { expo } = require('./app.json');

module.exports = () => {
  const projectId = process.env.EXPO_PROJECT_ID || expo?.extra?.eas?.projectId;

  return {
    ...expo,
    updates: {
      ...(expo.updates ?? {}),
      ...(projectId ? { url: `https://u.expo.dev/${projectId}` } : {}),
      requestHeaders: {
        ...(expo.updates?.requestHeaders ?? {}),
        'expo-channel-name': 'production',
      },
    },
    extra: {
      ...(expo.extra ?? {}),
      eas: {
        ...(expo.extra?.eas ?? {}),
        ...(projectId ? { projectId } : {}),
      },
    },
  };
};
