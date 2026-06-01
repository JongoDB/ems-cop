// TanStack Query mutation for the C2 implant generator endpoint.
//
// Backend contract:
//   POST /api/v1/c2/implants/generate?provider=<name>
//   body: ImplantSpec JSON
//   200 -> ImplantBinary { name, size }   (binary bytes are NOT in the JSON; they
//                                          live on the C2 server volume)
//   4xx -> { error: { code, message } }   (apiFetch surfaces .message)
//
// The mutation accepts both the spec and the provider name in one input and
// builds the URL/query-string accordingly.

import { useMutation } from '@tanstack/react-query'
import { apiFetch } from '../lib/api'

export type ImplantOS = 'windows' | 'linux' | 'darwin'
export type ImplantArch = 'amd64' | 'arm64' | '386'
export type ImplantFormat = 'exe' | 'shared' | 'service' | 'shellcode'
export type ImplantTransport = 'mtls' | 'http' | 'https' | 'dns' | 'wg'

export interface ImplantSpec {
  os: ImplantOS
  arch: ImplantArch
  format: ImplantFormat
  transport: ImplantTransport
  c2_url: string
  skip_symbols?: boolean
}

export interface ImplantBinary {
  name: string
  size: number
  // The backend tags Data with `json:"-"` today, so this is rarely populated.
  // If a provider ever returns base64 bytes here, the modal can offer a real
  // download — until then, we just show the metadata.
  data?: string
}

export interface GenerateImplantInput {
  provider: string
  spec: ImplantSpec
}

export function useGenerateImplant() {
  return useMutation<ImplantBinary, Error, GenerateImplantInput>({
    mutationFn: async ({ provider, spec }) => {
      const qs = provider ? `?provider=${encodeURIComponent(provider)}` : ''
      // Log spec metadata (NOT the resulting binary content) for traceability.
      // eslint-disable-next-line no-console
      console.info('[implant.generate]', {
        provider,
        os: spec.os,
        arch: spec.arch,
        format: spec.format,
        transport: spec.transport,
      })
      return await apiFetch<ImplantBinary>(`/c2/implants/generate${qs}`, {
        method: 'POST',
        body: JSON.stringify(spec),
      })
    },
  })
}
