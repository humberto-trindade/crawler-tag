# Kit portátil: auditoria de tags sem Docker

Este kit executa o mesmo motor de exploração da versão completa
(`cloud-run-app/src/crawler/explorer.ts`), portado para Python e Playwright.
Não precisa de Docker, Node, PostgreSQL nem outro serviço: tudo roda em uma
pasta no Windows e os resultados são arquivos locais (CSV, JSON, HTML, PDF).

Serve para **testes controlados em sites que você está autorizado a auditar**.
Não é instalador corporativo nem ambiente de produção.

## O que instalar

| Item | Versão | Observação |
|---|---|---|
| Windows | 10 ou 11 | Os scripts de início são `.bat` |
| Python | 3.10 ou superior | No PATH, com pip (marque "Add python.exe to PATH" e "pip" no instalador) |
| Playwright (Python) | 1.61.0 | Instalado sozinho pelo `INICIAR.bat` a partir de `requirements.txt` |
| Chromium | o do Playwright | Baixado sozinho para `portable-local\browsers` (~150 MB, mais ~500 MB descompactado) |

Não é preciso instalar nada além do Python. Espaço livre recomendado: 1 GB.

## Acessos necessários

**Rede (só na primeira execução, para instalar):**
- `pypi.org` e `files.pythonhosted.org` (pacote `playwright`);
- CDN do Playwright (`cdn.playwright.dev` / `playwright.azureedge.net`), para baixar o Chromium.

Em rede corporativa com proxy ou inspeção TLS, peça liberação desses endereços ou instale numa máquina com acesso e copie a pasta.

**Rede (em toda execução):** saída HTTPS para os sites que serão auditados e para os domínios de tags (Google, Meta, TikTok etc.) que eles carregam. O crawler só navega nos domínios permitidos da jornada.

**Computador:**
- permissão para executar o Chromium em modo headless (sem janela);
- porta local `3000` livre (a interface só escuta em `127.0.0.1`, não fica exposta na rede);
- permissão de escrita na pasta do kit (`data`, `exports`, `logs`, `saidas`).

**Contas:** nenhuma. O kit não faz login, não usa credenciais e não envia dados para fora do computador.

## Primeira execução

1. Copie ou clone esta pasta (`portable-local`) para o computador.
2. Execute `INICIAR.bat`. Na primeira vez ele instala o Playwright e o Chromium (alguns minutos). Nas seguintes, abre direto.
3. Abra `http://127.0.0.1:3000` (o navegador abre sozinho).
4. Para usar jornadas monitoradas, copie `config\jornadas.exemplo.csv` para `config\jornadas.csv` e ajuste, ou crie pela interface (seção "Jornadas").

Para encerrar o servidor, use `Ctrl+C` na janela do inicializador.

## Comportamento esperado

**Uma execução avulsa** (formulário da página inicial): informe a URL, domínios permitidos, profundidade e limites; escolha o template de preenchimento. O status vai de `queued` para `running` e termina em `completed`, `failed`, `paused` ou `stopped`.
- `completed`: a fila terminou ou um limite foi atingido (o motivo fica em `stopReason`).
- `paused`: apareceu CAPTCHA; o crawler não tenta resolver nem contornar.
- `failed`: nenhuma página carregou (ex.: sem acesso ao site).
- `stopped`: você usou "Interromper"; o resultado parcial é mantido.

**Durante a execução o crawler:**
- navega em largura (BFS) respeitando profundidade, máximo de estados e de ações e domínios permitidos;
- aceita banners de consentimento;
- preenche formulários, modais e assistentes em várias etapas com **dados sintéticos** do template (e-mails só em domínio de teste); em modais que exigem escolher um item (ex.: "Selecione até 3 serviços"), escolhe o primeiro para habilitar o avanço;
- clica em CTAs e botões de avançar, mas **para antes de compra e pagamento**: botões e URLs de compra não são acionados e telas com campos de cartão encerram o avanço;
- detecta GA4/GTM, Meta Pixel, Google Ads, TikTok, LinkedIn, Clarity/Hotjar e outras requisições de tracking, com parâmetros sanitizados (token, cookie, e-mail e telefone são mascarados);
- registra CAPTCHA, WAF/Cloudflare e downloads como avisos, sem explorar essas rotas;
- tira capturas de estado em miniatura (JPEG, até 20 por execução).

**Tempo e travamentos:** o motor roda em processo separado, vigiado por um watchdog. Sem atividade por 150 s, o processo e o Chromium são encerrados e a execução termina com o resultado parcial e `stopReason: watchdog_sem_progresso...`. Até 2 retomadas automáticas da fila pendente. Teto absoluto de 40 minutos por execução e 120 s por URL. Uma execução típica de uma jornada leva de 1 a 4 minutos.

**Fora do escopo (o crawler para):** compra e pagamento, dados pessoais reais, upload de documentos, contas reais/login, resolução de CAPTCHA ou contorno de WAF, domínios não autorizados.

## Jornadas monitoradas (recomendado)

- **Interface em abas:** *1. Jornadas* (lista e botão **Executar agora**), *2. Cadastro*, *3. Resultados* e *Execução avulsa*. Ao executar, uma faixa fixa no topo mostra o andamento (cronômetro, etapa atual, telas, ações e eventos) em qualquer aba; ao terminar, o botão **Ver resultado** abre a aba Resultados. Se a página for recarregada durante uma execução, o acompanhamento é retomado.
- **Cadastro:** a aba Jornadas lista as jornadas de `config\jornadas.csv`. Crie ou edite pela aba Cadastro. O arquivo abre no Excel (separador `;`, UTF-8 com BOM). Este arquivo é local e não vai para o Git; o modelo é `config\jornadas.exemplo.csv`.
- **Execução automática:** `python executar_jornadas.py` roda as jornadas ativas cujo intervalo já passou (`--so <id>` roda uma respeitando o intervalo; `--forcar <id>` ignora o intervalo). Para rodar de hora em hora no Windows, crie uma tarefa no Agendador de Tarefas com ação `python`, argumentos `executar_jornadas.py` e "Iniciar em" a pasta `portable-local`. O Chromium instalado pelo `INICIAR.bat` é encontrado automaticamente.
- **Modo URL única:** explora só a página da jornada e seus botões (CTAs), sem seguir links do site.

## Pontos de medição do pixel Meta

Cada jornada pode ter até três pontos: PDP, shortform e lead intent (a compra não é medida: fica depois do pagamento). Como esses pontos não estão em nenhum mapa de métricas que o crawler leia, **quem configura informa como identificá-los**.

Cada ponto tem:
- **URL** do ponto (vazio = não medido);
- **critério** opcional, combinado com E: **etapa** (`3 de 3`, `Passo 3 de 3`, `3/3` ou texto da tela), **título** da tela e **evento Meta esperado** (ex.: `Lead`, o parâmetro `ev` da requisição).

Muitos fluxos trocam de tela por modais ou SPA sem mudar a URL; por isso o crawler identifica cada tela por **URL + rótulo da tela + passo visível** (ex.: `1 de 3 - Agendamento`) e grava cada evento com esse estado.

Status de cada ponto:

| Status | Significado |
|---|---|
| `disparou` | a tela do ponto foi localizada e o pixel Meta (e o evento esperado, se informado) disparou |
| `missing` | a tela foi localizada, mas sem pixel Meta ou sem o evento esperado |
| `criterio_nao_localizado` | a URL foi alcançada, mas nenhuma tela atende ao critério: revisar o critério ou o cadastro da tag |
| `indistinguivel` | dois pontos com a mesma URL e o mesmo critério: a configuração não separa os dois |
| `blocked` | URL não alcançada e a execução foi barrada (clique sem efeito, CAPTCHA, watchdog) |
| `not_reached` | URL não alcançada, sem bloqueio |

`criterio_nao_localizado`, `indistinguivel`, `blocked` e `not_reached` **não indicam pixel quebrado**.

**Compra (guarda, não é medida):** informe em `ponto_compra` a URL em que o avanço é a compra (ex.: o botão Continuar da etapa de dados). Nessa URL o crawler preenche os campos, mas **não clica em nenhum botão de avanço**, e registra o aviso `purchase_guard`. Além disso, botões e URLs de compra/pagamento e telas com campos de cartão nunca são acionados.

**Como descobrir o critério certo:** se você sabe que precisa, por exemplo, "o passo 3" mas não sabe como identificá-lo, execute a jornada sem critério (ou com um critério provisório). O arquivo de estados traz a **jornada completa em ordem**, inclusive telas sem nenhum pixel (eventos = 0), com os eventos Meta de cada tela. Escolha nele a etapa, o título ou o evento e preencha o ponto.

## Onde ficam os resultados

- `saidas\<jornada>\<data_hora>_<execução>.csv`: um evento por linha (abre no Excel).
- `saidas\<jornada>\<data_hora>_<execução>_estados.csv`: a jornada em ordem, um registro por tela (URL, rótulo, passo, eventos, eventos Meta e seus nomes, tecnologias, ponto associado).
- `saidas\<jornada>\<data_hora>_<execução>_pontos.csv`: status de cada ponto, tela localizada e detalhe.
- `saidas\<jornada>\<data_hora>_<execução>.json`: registro técnico completo (grande; serve para auditoria, não precisa ser aberto no uso normal).
- `saidas\<jornada>\resumo.csv`: histórico só daquela jornada (mesmas colunas do resumo geral).
- `saidas\resumo.csv`: uma linha por execução, com tecnologias novas e ausentes em relação à execução anterior da mesma jornada e o status de cada ponto.
- `data\<id>.json` e `exports\execution-<id>.json | .csv | .html | .pdf`: execução avulsa e seus relatórios.
- `logs\portable-<data-hora>.log`: um arquivo por inicialização, sem cookies nem credenciais.

As pastas de resultados não vão para o Git. Os arquivos de resultado contêm URLs e parâmetros de tracking já mascarados, mas revise antes de compartilhar fora da equipe.

## Templates de preenchimento

Ficam em `templates\*.json` e seguem o formato de `templateSchema` da versão completa (`data.keys` com `key`, `value` e `matchers`). O padrão, `sintetico-padrao.json`, usa só dados fictícios. O kit recusa templates com e-mail fora de domínio sintético (`.test`, `example.com`, `example.test`, `mailinator.com`). Não coloque dados pessoais reais nos templates: o kit só valida o e-mail.

## Configuração avançada

- `CRAWLER_EXPORTS=0` desliga relatórios e downloads (CSV, JSON, PDF e HTML); a API responde 404 `exports_disabled`.
- `PLAYWRIGHT_BROWSERS_PATH` muda a pasta do Chromium (padrão: `portable-local\browsers`).

## Diferenças conhecidas em relação à versão completa

- O limite de 120 s por URL é verificado entre as etapas, não interrompe uma chamada do navegador em andamento.
- Capturas ficam em base64 dentro do JSON, o que pode deixá-lo grande em execuções longas.
- Só o engine Playwright (sem engine `fetch` nem integração com o crawler-service).
- Sem persistência centralizada nem RBAC.
- A detecção de mudança de tela é heurística (rótulo, passo visível, URL): telas muito parecidas podem ser tratadas como a mesma.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `python` não é reconhecido | Python fora do PATH: reinstale marcando "Add to PATH" |
| Falha ao instalar o Chromium | Sem acesso à CDN do Playwright (proxy); veja "Acessos necessários" |
| Porta 3000 em uso | Outro programa usa a porta; feche-o |
| Execução `failed` sem páginas | Site inacessível, bloqueado pela rede ou fora dos domínios permitidos |
| Execução `paused` | CAPTCHA detectado; o crawler não o resolve |
| `stopReason` com `watchdog` | O navegador travou; o resultado parcial foi salvo |
| Ponto `criterio_nao_localizado` | Etapa/título informado não aparece: confira o arquivo de estados |

## Testes

Na pasta `portable-local`:

```
python -m unittest discover -s tests -t .
```

São testes unitários e de contrato (não abrem sites reais): detecção, mapeamento de campos, estados e pontos, saídas e watchdog.
