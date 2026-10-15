# Execucao local sem Docker

Este kit executa uma versao portatil da aplicacao a partir de uma pasta no
Windows. O cliente precisa de Python 3.10+ com pip e executa `INICIAR.bat`.
Na primeira execucao, o inicializador instala Playwright e Chromium na propria
pasta.
A interface abre em `http://127.0.0.1:3000`.

## Requisitos do computador cliente

- Windows 10/11;
- Python 3.10+ no PATH;
- pip habilitado para instalar Playwright;
- acesso de rede aos dominios autorizados;
- permissao para abrir a porta local 3000.

O armazenamento e feito em arquivos locais. Cada execucao gera JSON, CSV, HTML
e PDF em `portable-local/exports`, sem banco externo.

## Preparacao

1. Distribua a pasta `portable-local` para o computador do funcionario.
2. Execute `INICIAR.bat`.
3. Informe a URL autorizada, limites e clique em executar.
4. Envie os arquivos de `exports` para analise, quando necessario.

Para encerrar, use Ctrl+C na janela do inicializador.

## Logs para diagnostico

Cada tentativa cria um arquivo em `portable-local/logs/`, por exemplo
`crawler-tag-20260817-090600.log`. O log registra:

- verificacao da aplicacao, URL e limites da auditoria;
- navegacao de cada URL, status HTTP, eventos encontrados e falhas;
- inicializacao e encerramento do servidor local;
- falhas inesperadas e identificador da execucao;
- URL do arquivo de log para facilitar o envio ao suporte.

Em caso de erro, envie o arquivo `.log` mais recente dessa pasta. Os logs não
registram cookies, tokens ou credenciais.

## Implicacoes da fase local

- cada cliente possui arquivos de resultados separados;
- não há alta disponibilidade, RBAC ou armazenamento centralizado;
- a versão Python usa Playwright/Chromium para executar JavaScript e cobrir
  melhor SPAs; a primeira instalação baixa o navegador;
- login, CAPTCHA, WAF e interações proibidas continuam sendo bloqueios seguros;
- a futura migração para AWS Fargate poderá usar um crawler browser-based e
  persistência centralizada, sem alterar os exports desta fase.

Esta abordagem e adequada para testes controlados em ambientes autorizados,
mas nao deve ser tratada como instalador corporativo ou ambiente de producao.
