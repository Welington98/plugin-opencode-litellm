# @welington98/opencode-litellm

Plugin **e provider** para o [OpenCode](https://opencode.ai) que integra automaticamente com um servidor [LiteLLM Proxy](https://docs.litellm.ai). Configure o **endpoint** e a **API key dentro do próprio OpenCode** — sem variáveis de ambiente, sem editar `opencode.json` e sem cadastrar modelo por modelo.

```text
Install plugin
    ↓
/connect  →  LiteLLM  (ou  /litellm setup)
    ↓
Endpoint:  https://litellm.example.com
API Key:   sk-****
    ↓
Test Connection  ✓  ✓  ✓
    ↓
14 models discovered  →  aparecem em /models
```

---

## Requisitos

- OpenCode 1.18+ (plugin `server()` + `tui()`).
- Um servidor LiteLLM Proxy acessível (com `GET /v1/models` e, idealmente, `/model_group/info`).

## Instalação

```bash
# opcional: via CLI (instala e adiciona ao config)
opencode plugin @welington98/opencode-litellm

# ou instale no TUI:
#   /plugins  →  install  →  @welington98/opencode-litellm
```

Ou adicione manualmente em `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@welington98/opencode-litellm"]
}
```

> Não é preciso declarar o provider nem os modelos. O plugin cuida de tudo.

---

## Uso

### 1. Configurar (onboarding)

Dentro do OpenCode:

- **`/connect`** → selecione **LiteLLM** → informe `Endpoint` e `API Key`.
- **ou `/litellm setup`** — fluxo interativo com **Test Connection** e feedback via toasts:

```text
LiteLLM Endpoint
> https://litellm.example.com

LiteLLM API Key
> sk-************************

Testing LiteLLM connection...
✓ Connected
✓ Authentication successful
✓ 14 models discovered
✓ Configuration saved
```

Após salvar, o OpenCode reinicia a instância e os modelos autorizados daquela API key aparecem automaticamente em **`/models`**:

```text
litellm/gpt-4o
litellm/claude-3-5-sonnet
litellm/gemini-pro
litellm/deepseek-r1
```

> A lista vem de `GET /v1/models` filtrado pela sua key. Se o admin do LiteLLM adicionar/remover um modelo, ele aparece/some após um refresh.

### 2. Comandos `/litellm`

| Comando | Ação |
| --- | --- |
| `/litellm` ou `/litellm status` | Tela de status (endpoint, key mascarada, nº de modelos, último refresh) |
| `/litellm setup` | Configurar / trocar endpoint ou API key (com teste de conexão) |
| `/litellm refresh` | Re-descobrir modelos (invalida o cache) |
| `/litellm disconnect` | Remove a credencial e os modelos descobertos |

### 3. Ferramentas do agente

O plugin também registra tools que o agente pode chamar em qualquer sessão (TUI ou CLI):

| Tool | Descrição |
| --- | --- |
| `litellm_status` | Mostra o estado atual da conexão |
| `litellm_test` | Testa endpoint + autenticação + descoberta |
| `litellm_refresh` | Atualiza o catálogo de modelos |
| `litellm_disconnect` | Remove credencial e modelos |

Exemplo de uso no chat: *“qual o status do meu LiteLLM?”* ou *“refresh nos modelos do LiteLLM”*.

### 4. CLI nativo

```bash
opencode auth login litellm    # endpoint + API key (com validação)
opencode auth logout litellm   # desconecta
opencode auth list             # lista credenciais
opencode models litellm        # lista modelos descobertos
```

---

## O que o plugin faz automaticamente

1. **Registra o provider `litellm`** no catálogo via o hook `config` do OpenCode (mecanismo oficial para providers dinâmicos).
2. **Descobre os modelos** autorizados da sua API key:
   - `GET <endpoint>/v1/models` → ids autorizados.
   - `GET <endpoint>/model_group/info` (fallback `/v1/model/info`) → capabilities.
3. **Mapeia capabilities** para o modelo do OpenCode:

| LiteLLM | OpenCode |
| --- | --- |
| `supports_vision` | `capabilities.input.image = true`, `attachment = true` |
| `supports_pdf_input` | `capabilities.input.pdf = true` |
| `supports_function_calling` | `capabilities.toolcall = true` |
| `supports_reasoning` | `capabilities.reasoning = true` |
| `supports_audio_input/output` | `capabilities.input/output.audio` |
| `max_input_tokens` | `limit.context` / `limit.input` |
| `max_output_tokens` | `limit.output` |
| `input/output_cost_per_token` | `cost` |

   Quando não há metadata, usa o fallback conservador: `text` + `toolcall` + `temperature` para modelos chat. **Nunca** declara visão/reasoning sem evidência.
4. **Roteia as requisições** como `OpenCode → plugin → LiteLLM Proxy → provider real`, usando `@ai-sdk/openai-compatible` com `baseURL = <endpoint>/v1` e `Authorization: Bearer <key>`. O OpenCode não precisa saber se o modelo real vem de OpenAI, Anthropic, Gemini, Bedrock, Azure, Ollama etc.

---

## Armazenamento seguro das credenciais

- A **API key** e o **endpoint** são salvos no armazenamento oficial de credenciais do OpenCode: `auth.json` no diretório de dados do OpenCode (`~/.local/share/opencode/auth.json` em Linux/macOS), criado com permissão **`0600`**.
- **Nunca** no repositório / git, e nunca exibidos por completo.
- Máscara central (`sk-1234567890abcdef` → `sk-************cdef`).
- A key é removida de qualquer mensagem de erro (`redactError`) antes de ser logada ou exibida.
- `disconnect` remove o registro inteiro — os modelos somem do seletor.

Cache de modelos (TTL de 5 min) é guardado no `metadata` da credencial, evitando chamadas excessivas ao LiteLLM no startup.

---

## Trocar endpoint / API key

Basta rodar **`/litellm setup`** novamente (ou `opencode auth login litellm`). O plugin:

1. Invalida o cache anterior;
2. Testa a nova conexão;
3. Re-descobre os modelos;
4. Atualiza o provider e o seletor.

## Desconectar

**`/litellm disconnect`** (ou `litellm_disconnect`, ou `opencode auth logout litellm`):

- remove a credencial salva;
- apaga a configuração sensível;
- remove os modelos descobertos;
- deixa o plugin instalado, porém não configurado.

---

## Tratamento de erros

| Situação | Mensagem |
| --- | --- |
| Endpoint inválido / protocolo inválido | `Endpoint must use http:// or https://` |
| DNS | `Could not resolve the LiteLLM endpoint host (DNS error).` |
| Timeout | `Request to LiteLLM timed out after 10000ms.` |
| TLS | `TLS error connecting to the endpoint. Check the certificate.` |
| Connection refused | `Connection refused. Is the LiteLLM proxy running and reachable?` |
| 401 | `Authentication failed. Check your LiteLLM API key.` |
| 403 | `Access denied (403). This key cannot list models.` |
| 404 em `/v1/models` | `Model list endpoint not found (404). Verify the endpoint points to the LiteLLM proxy root.` |
| Resposta inválida / lista vazia | mensagens específicas |
| Chave revogada / LiteLLM offline | erros de auth/network acima |

Nenhuma mensagem contém a API key.

---

## Arquitetura

```
┌─ server.ts ─────────────────────────────────────────────┐
│  auth hook    → /connect + `opencode auth login litellm` │
│                (loader injeta { apiKey, baseURL })       │
│  config hook  → registra provider "litellm" + modelos    │
│                (cache → descoberta sob demanda)          │
│  tools        → litellm_status/test/refresh/disconnect   │
└──────────────────────────────────────────────────────────┘
┌─ tui.tsx ────────────────────────────────────────────────┐
│  /litellm, /litellm setup|status|refresh|disconnect      │
│  dialogs + toasts + reload automático da instância       │
└──────────────────────────────────────────────────────────┘
```

```
src/
├── server.ts                entrada server (config + auth + tools)
├── tui.tsx                  entrada tui (comandos /litellm)
├── config/                  settings + validação de endpoint/key
├── litellm/                 client HTTP, discovery, capabilities
├── provider/                mapeamento de modelos + config-provider
├── security/                maskSecret / redactError
├── store/                   leitura/remoção de auth.json
└── types.ts
scripts/mock-litellm.ts      proxy LiteLLM de mentira para testes/demos
tests/                       bun test (mock server herméticos)
```

## Desenvolvimento

```bash
bun install
bun test          # roda os testes
bun run typecheck
bun run build     # gera dist/ (server.js + tui.js)

# demo local com um LiteLLM falso:
bun scripts/mock-litellm.ts 4000

# instalar a versão local em um projeto de teste:
#   copie dist/ para onde preferir e aponte o plugin para ele
#   (ou publique o pacote e use opencode plugin @welington98/opencode-litellm)
```

## Release & publicação (CI)

- **Versionamento**: `semantic-release` roda em `.github/workflows/release.yml` a cada push para `main` — analisa os Conventional Commits, gera `CHANGELOG.md` e cria a GitHub Release.
- **npm**: a publicação em `@welington98/opencode-litellm` fica **desabilitada** até o secret `NPM_TOKEN` ser configurado no repositório. Para habilitar: `gh secret set NPM_TOKEN` com um token npm (Automation) e reativar `@semantic-release/npm` no `release.config.cjs`.
- O repo é público, então o workflow é autocontido (não chama reusable workflows internos da org).

---

## Limitações conhecidas

- **Sem keychain do SO**: o OpenCode não expõe API de keychain para plugins; usamos o `auth.json` oficial (0600).
- **`/connect` nativo** salva a credencial e a descoberta roda em seguida; o teste explícito com feedback é feito por `/litellm setup` (e pelo CLI `auth login`).
- **Comandos `/litellm`** exigem o TUI; no CLI use `opencode auth login/logout/list`.
- **Metadata de capabilities** depende da versão/permissões do LiteLLM; sem ela, fallback conservador (text+tools+temperature).
- **Sem polling**: refresh acontece no startup (com cache/TTL), por comando (`/litellm refresh`), ou ao trocar a configuração.
- Providers que **não estão** no catálogo models-dev do OpenCode (como `litellm`) são registrados via o hook `config` — mecanismo oficial suportado.

---

## Licença

MIT
