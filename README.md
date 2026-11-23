# WavePulse fetcher

Tarefa de hora a hora (GitHub Actions) que pede previsões ao [Open-Meteo](https://open-meteo.com) (CC BY 4.0) e as entrega ao servidor da WavePulse, uma app gratuita e não comercial de previsão para surf, bodyboard, skimboard e dia de praia.

- `plan.json`: os pedidos a fazer (gerado pela app; não editar à mão).
- `fetch.mjs`: o programa, sem dependências. Cada hora faz uma parte, para cobrir tudo uma vez por dia dentro do limite gratuito.
- O segredo `INGEST_TOKEN` fica nas definições do repositório (Settings → Secrets and variables → Actions). Nunca no código.

Dados meteorológicos: Open-Meteo.com, licença CC BY 4.0.
