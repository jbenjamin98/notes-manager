/** Where to get an API key, step by step, for each supported provider. */
export interface KeyGuide {
  id: 'gemini' | 'groq' | 'openrouter' | 'openai' | 'anthropic'
  name: string
  cost: string
  /** What a real key looks like, so people can tell they copied the right thing. */
  looksLike: string
  steps: string[]
  note?: string
}

export const KEY_GUIDES: KeyGuide[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    cost: 'Free tier. No credit card.',
    looksLike: 'AIza…',
    steps: [
      'Press “Open the key page” and sign in with a Google account. A personal account is simplest; some work accounts are blocked by an administrator.',
      'Choose “Create API key”. If it asks for a project, pick “Create API key in new project”.',
      'Copy the key it shows.',
      'Paste it below, press Save, then Test.'
    ],
    note: 'This is separate from a Gemini Advanced / Google AI Pro subscription, which does not include an API key.'
  },
  {
    id: 'groq',
    name: 'Groq',
    cost: 'Free tier. No credit card.',
    looksLike: 'gsk_…',
    steps: [
      'Open the key page and sign up (Google, GitHub or email).',
      'Choose “Create API Key” and give it any name.',
      'Copy the key right away. Groq shows it only once.',
      'Paste it below, press Save, then Test.'
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    cost: 'Free models available; others need prepaid credit.',
    looksLike: 'sk-or-…',
    steps: [
      'Open the key page and sign in.',
      'Choose “Create Key” and name it.',
      'Copy the key.',
      'Paste it below, press Save. Then open “Model names” on its card and enter the model you want (models ending in “:free” cost nothing). Press Test.'
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    cost: 'Paid. Billed per request to your OpenAI account.',
    looksLike: 'sk-…',
    steps: [
      'Open the key page and sign in to the OpenAI Platform (this is not the ChatGPT app).',
      'Add a few dollars of credit under Billing. A ChatGPT Plus subscription does not cover the API.',
      'Choose “Create new secret key” and copy it. It is shown only once.',
      'Paste it below, press Save, then Test.'
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    cost: 'Paid. Billed per request to your Anthropic account.',
    looksLike: 'sk-ant-…',
    steps: [
      'Open the key page and sign in to the Anthropic Console (this is not the Claude chat app).',
      'Add credit under Plans & Billing. A Claude Pro subscription does not cover the API.',
      'Choose “Create Key”, name it and copy it. It is shown only once.',
      'Paste it below, press Save, then Test.'
    ]
  }
]
