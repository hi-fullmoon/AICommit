export function userConfig(input = {}) {
  const {
    providerName = 'test',
    modelName = 'default',
    apiUrl = 'http://127.0.0.1:11434/v1/chat/completions',
    apiKey = '',
    apiKeyEnv = '',
    providerType = 'custom',
    modelId = 'test-model',
    extraBody,
    models,
    defaultModel = modelName,
    ...globalConfig
  } = input;

  return {
    schemaVersion: 1,
    defaultProvider: providerName,
    providers: {
      [providerName]: {
        providerType,
        apiUrl,
        apiKey,
        apiKeyEnv,
        defaultModel,
        models: models || {
          [modelName]: {
            modelId,
            ...(extraBody ? { extraBody } : {}),
          },
        },
      },
    },
    ...globalConfig,
  };
}
