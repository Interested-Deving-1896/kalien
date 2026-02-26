export const boundlessMarketAbi = [
  {
    type: "function",
    name: "submitRequest",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          {
            name: "requirements",
            type: "tuple",
            components: [
              {
                name: "callback",
                type: "tuple",
                components: [
                  { name: "addr", type: "address" },
                  { name: "gasLimit", type: "uint96" },
                ],
              },
              {
                name: "predicate",
                type: "tuple",
                components: [
                  { name: "predicateType", type: "uint8" },
                  { name: "data", type: "bytes" },
                ],
              },
              { name: "selector", type: "bytes4" },
            ],
          },
          { name: "imageUrl", type: "string" },
          {
            name: "input",
            type: "tuple",
            components: [
              { name: "inputType", type: "uint8" },
              { name: "data", type: "bytes" },
            ],
          },
          {
            name: "offer",
            type: "tuple",
            components: [
              { name: "minPrice", type: "uint256" },
              { name: "maxPrice", type: "uint256" },
              { name: "rampUpStart", type: "uint64" },
              { name: "rampUpPeriod", type: "uint32" },
              { name: "lockTimeout", type: "uint32" },
              { name: "timeout", type: "uint32" },
              { name: "lockCollateral", type: "uint256" },
            ],
          },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "requestIsFulfilled",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "requestIsLocked",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "deposit",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "requestLocks",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [
      { name: "price", type: "uint96" },
      { name: "prover", type: "address" },
      { name: "collateral", type: "uint96" },
      { name: "isPaid", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "ProofDelivered",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "prover", type: "address", indexed: true },
      {
        name: "fulfillment",
        type: "tuple",
        indexed: false,
        components: [
          { name: "id", type: "uint256" },
          { name: "requestDigest", type: "bytes32" },
          { name: "claimDigest", type: "bytes32" },
          { name: "fulfillmentDataType", type: "uint8" },
          { name: "fulfillmentData", type: "bytes" },
          { name: "seal", type: "bytes" },
        ],
      },
    ],
  },
] as const;

export const eip712Types = {
  ProofRequest: [
    { name: "id", type: "uint256" },
    { name: "requirements", type: "Requirements" },
    { name: "imageUrl", type: "string" },
    { name: "input", type: "Input" },
    { name: "offer", type: "Offer" },
  ],
  Requirements: [
    { name: "callback", type: "Callback" },
    { name: "predicate", type: "Predicate" },
    { name: "selector", type: "bytes4" },
  ],
  Predicate: [
    { name: "predicateType", type: "uint8" },
    { name: "data", type: "bytes" },
  ],
  Callback: [
    { name: "addr", type: "address" },
    { name: "gasLimit", type: "uint96" },
  ],
  Input: [
    { name: "inputType", type: "uint8" },
    { name: "data", type: "bytes" },
  ],
  Offer: [
    { name: "minPrice", type: "uint256" },
    { name: "maxPrice", type: "uint256" },
    { name: "rampUpStart", type: "uint64" },
    { name: "rampUpPeriod", type: "uint32" },
    { name: "lockTimeout", type: "uint32" },
    { name: "timeout", type: "uint32" },
    { name: "lockCollateral", type: "uint256" },
  ],
} as const;
