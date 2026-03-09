/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_NETWORK_PASSPHRASE?: string;
  readonly VITE_ACCOUNT_WASM_HASH?: string;
  readonly VITE_WEBAUTHN_VERIFIER_ADDRESS?: string;
  readonly VITE_RELAYER_PROXY_URL?: string;
  readonly VITE_RP_NAME?: string;
  readonly VITE_SCORE_CONTRACT_ID?: string;
  readonly VITE_TOKEN_CONTRACT_ID?: string;
  readonly VITE_KALE_SAC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
