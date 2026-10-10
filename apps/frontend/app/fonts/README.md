# Fontes do painel

Fraunces (títulos) e Inter (texto), servidas a partir destes arquivos. O build do painel **não consulta o Google Fonts nem rede nenhuma**: `next/font/local` lê o que está aqui (ver `index.ts`).

Antes, `next/font/google` baixava as fontes durante o `next build`. Em 09/10/2026 o build falhou duas vezes seguidas no CI porque o Google devolveu a alguns runners uma resposta que o Next 15.5.27 não trata. Estes são **os mesmos dez arquivos que o build anterior já embutia, byte a byte** — nada foi convertido, recortado nem regerado.

## Origem

Baixados em 09/10/2026 do Google Fonts (`fonts.gstatic.com`), pelos endereços que a API de CSS do Google devolve para os pedidos que o painel fazia:

- Fraunces — `https://fonts.googleapis.com/css2?family=Fraunces:wght@400;500;600&display=swap`
- Inter — `https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap`

O Google serve cada fonte dividida em subconjuntos de caracteres, um arquivo por subconjunto, cada um com a sua faixa (`unicode-range`). As faixas estão copiadas em `index.ts`.

### Fraunces

Versão gravada nos arquivos: `Version 1.000;[b76b70a41]`. Fonte variável só no peso (`wght` 100–900); os demais eixos da Fraunces (`opsz`, `SOFT`, `WONK`) já vêm fixados pelo Google nos valores padrão. O painel declara os pesos 400, 500 e 600.

| Arquivo | Subconjunto | Tamanho | SHA-256 |
|---|---|---|---|
| `fraunces/fraunces-vietnamese.woff2` | vietnamese | 11.536 bytes | `250cc2966c658fb6d336731de9d82a8129025e9839c20c253bbc477852f6cf4f` |
| `fraunces/fraunces-latin-ext.woff2` | latin-ext | 33.640 bytes | `f1451edd6434085c4f9f3a8b4a674182dd7d6acccf53bfced19fd167f0705a06` |
| `fraunces/fraunces-latin.woff2` | latin | 36.560 bytes | `88e17be075f1be50ab67b057b99e3701b828f44ed28f9452df6c02645bb0cba9` |

- `fraunces-vietnamese.woff2` — <https://fonts.gstatic.com/s/fraunces/v38/6NUu8FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Wa0K7iN7hzFUPJH58nib14c0qv8oRcTnaIM.woff2>
- `fraunces-latin-ext.woff2` — <https://fonts.gstatic.com/s/fraunces/v38/6NUu8FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Wa0K7iN7hzFUPJH58nib14c1qv8oRcTnaIM.woff2>
- `fraunces-latin.woff2` — <https://fonts.gstatic.com/s/fraunces/v38/6NUu8FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Wa0K7iN7hzFUPJH58nib14c7qv8oRcTn.woff2>

### Inter

Versão gravada nos arquivos: `Version 4.001;git-66647c0bb`. Fonte variável só no peso (`wght` 100–900); o eixo `opsz` já vem fixado pelo Google no valor padrão. O painel declara a faixa inteira, 100–900.

| Arquivo | Subconjunto | Tamanho | SHA-256 |
|---|---|---|---|
| `inter/inter-cyrillic-ext.woff2` | cyrillic-ext | 25.844 bytes | `fccca918fea40089dacadc7045861314d1a6bc91f1f323cc1eeb22ebcdb321b5` |
| `inter/inter-cyrillic.woff2` | cyrillic | 18.744 bytes | `aebf2ab4a4ce6810d73c1ac7be7cafb4e5ec4cee2d6db5fb3e09691747ec4bd6` |
| `inter/inter-greek-ext.woff2` | greek-ext | 11.272 bytes | `a2e2c783ca6f9c20486e81e72a279203e86730bbf8f01ff6a5ee9dbd09e1c271` |
| `inter/inter-greek.woff2` | greek | 19.044 bytes | `46dd4cdca58c26ae87cc6927657bf83b2e8abfc39ffd0ab176e301a8d28d22bf` |
| `inter/inter-vietnamese.woff2` | vietnamese | 10.280 bytes | `8db00ff46c67b22cda8bed865acf7077651cac8d2841d5b40980556b48961931` |
| `inter/inter-latin-ext.woff2` | latin-ext | 85.272 bytes | `a28eb6d3ccb534ae0c94ca999371df024aab60b08c3c8a5720ee9e32fa0faaa2` |
| `inter/inter-latin.woff2` | latin | 48.432 bytes | `c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4` |

- `inter-cyrillic-ext.woff2` — <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2JL7W0Q5n-wU.woff2>
- `inter-cyrillic.woff2` — <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa0ZL7W0Q5n-wU.woff2>
- `inter-greek-ext.woff2` — <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2ZL7W0Q5n-wU.woff2>
- `inter-greek.woff2` — <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1pL7W0Q5n-wU.woff2>
- `inter-vietnamese.woff2` — <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2pL7W0Q5n-wU.woff2>
- `inter-latin-ext.woff2` — <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7W0Q5n-wU.woff2>
- `inter-latin.woff2` — <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2>

Total: 10 arquivos, 300.624 bytes.

## Licença

As duas famílias são distribuídas sob a **SIL Open Font License, versão 1.1**, que permite usar, embutir e redistribuir as fontes, inclusive junto de software comercial, desde que o aviso de direitos autorais e o texto da licença acompanhem os arquivos. Nenhuma das duas declara nome reservado.

- `fraunces/OFL.txt` — cópia de <https://github.com/google/fonts/blob/main/ofl/fraunces/OFL.txt> (SHA-256 `bdf4c22802eaf804f998195871c6b8938aac2ac14b2d78a8bd66a6f1eced833b`).
- `inter/OFL.txt` — cópia de <https://github.com/google/fonts/blob/main/ofl/inter/OFL.txt> (SHA-256 `5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57`).

Cada arquivo de fonte também traz, nos próprios metadados, o aviso de direitos autorais e o endereço da licença:

- Fraunces — "Copyright 2020 The Fraunces Project Authors (github.com/undercasetype/Fraunces)", <https://scripts.sil.org/OFL>.
- Inter — "Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)", <https://openfontlicense.org>.

O ano do aviso gravado nas fontes difere do ano no cabeçalho do `OFL.txt` do repositório do Google (2018 para a Fraunces, 2020 para a Inter). Os dois foram mantidos como vieram.

## Como conferir

```bash
sha256sum apps/frontend/app/fonts/*/*.woff2
```

Os valores têm de bater com as tabelas acima. Os primeiros 16 dígitos hexadecimais do nome que o Next dá a cada arquivo em `.next/static/media` vêm do conteúdo: por isso os nomes emitidos hoje são os mesmos de antes, sem o sufixo `-s`.

## Para trocar ou atualizar uma fonte

1. Baixe os arquivos novos de uma origem oficial e confira a licença.
2. Substitua os arquivos e as faixas em `index.ts`, mantendo a ordem das chamadas (quando duas faixas se sobrepõem, vale a face declarada por último).
3. Atualize as tabelas e os avisos deste arquivo.
4. Rode o build e confira a tela: a troca de versão de uma fonte muda o desenho das letras.
