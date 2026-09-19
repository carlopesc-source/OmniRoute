# Whale Watch — vigilancia de ballenas, liquidez y presión vendedora (Solana)

Script sin dependencias (Node ≥ 22) que, para cada token de `tokens.json`:

1. Saca los **mayores holders** (20 cuentas más grandes vía RPC público, o la lista completa con
   Helius) y los agrupa por wallet propietaria.
2. Etiqueta pools/LP, quemados, exchanges e _insiders_ (RugCheck + `labels.json`).
3. Guarda un **snapshot** y lo compara con el anterior: quién vendió, quién salió, quién entró,
   quién acumula.
4. Lee **precio, liquidez, market cap, compras/ventas y variación** (DexScreener).
5. Evalúa un conjunto de **reglas con umbrales configurables** y genera un informe Markdown.
6. Envía **alertas** (Telegram / Discord) solo cuando una señal es nueva (cooldown anti-spam).

Todo lo que informa son **datos observados + umbrales que tú configuras**. El script nunca afirma
_por qué_ una wallet se movió: solo informa de _que_ se movió, cuánto y cuándo.

## Lo que NO puede hacer (léelo antes de fiarte)

| Herramienta        | Qué aporta                                                         | Aquí                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bubblemaps         | Agrupa wallets que se financian entre sí (clusters)                | **No replicable** con datos públicos gratuitos. Lo más parecido es el flag `insider` y `insiderNetworks` del informe de RugCheck, que es lo que usa el script. |
| Arkham             | Pone nombre a wallets (fondos, exchanges, traders)                 | **No hay fuente pública** equivalente. El script usa `knownAccounts` de RugCheck y el fichero manual `labels.json`, que rellenas tú.                           |
| RPC público Solana | `getTokenLargestAccounts` devuelve **solo las 20 cuentas mayores** | Un holder que sale de ese top-20 aparece como `LEFT_TOP`, no como "vendió todo". Con `HELIUS_API_KEY` se descarga la lista completa (plan gratuito de Helius). |

Aviso de rigor: este script se escribió en un entorno **sin acceso de red** a DexScreener, al RPC
de Solana ni a RugCheck (la política de salida los bloquea). La lógica pura está cubierta por tests
(`tests/unit/whale-watch-lib.test.ts`), pero los nombres de campo de las respuestas de RugCheck y
DexScreener **no se han verificado contra respuestas reales en esta sesión**; el código accede a
todos ellos de forma tolerante (un campo ausente da `n/d`, no un fallo). Si un campo viene con otro
nombre, el informe lo mostrará como `n/d` y hay que ajustar `sources.mjs`.

## Puesta en marcha

```bash
# 1) Resolver los mints. NO hay mints precargados: se buscan en DexScreener por símbolo y
#    se listan TODOS los candidatos con su liquidez para que confirmes cuál es el tuyo.
node scripts/research/whale-watch/whale-watch.mjs resolve
node scripts/research/whale-watch/whale-watch.mjs resolve --write   # guarda el más líquido, marcado mintVerified=false

# 2) Confirma cada mint contra el que aparece en tu wallet/DexScreener y pon mintVerified=true.

# 3) Primer snapshot (línea base) y vigilancia continua cada 5 min
node scripts/research/whale-watch/whale-watch.mjs snapshot
node scripts/research/whale-watch/whale-watch.mjs watch --interval 300

# Informe del último snapshot sin red
node scripts/research/whale-watch/whale-watch.mjs report
```

Variables de entorno opcionales:

| Variable                                  | Efecto                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `HELIUS_API_KEY`                          | Lista completa de holders (`getTokenAccounts`) en vez del top-20.                          |
| `SOLANA_RPC_URL`                          | RPC alternativo (el público limita ~100 peticiones / 10 s).                                |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Alertas por Telegram.                                                                      |
| `DISCORD_WEBHOOK_URL`                     | Alertas por Discord.                                                                       |
| `WHALE_WATCH_DIR`                         | Dónde guardar estado e informes (por defecto `_artifacts/whale-watch/`, ignorado por git). |

Estado: `_artifacts/whale-watch/state/<SYMBOL>/<ts>.json` (últimos 500 por token) + `latest.json`;
informes en `_artifacts/whale-watch/reports/` **siempre en `.md` y `.html`** (regla del operador); cooldown de alertas en `alerts.json`.

## Señales (todas con valor observado + umbral en el informe)

| Señal                    | Severidad     | Dispara cuando (umbral por defecto)                                         | Fuente                         |
| ------------------------ | ------------- | --------------------------------------------------------------------------- | ------------------------------ |
| `TOP10_CONCENTRATION`    | WARN / DANGER | top-10 holders no-pool ≥ 30 % / ≥ 50 % del supply                           | RPC / Helius                   |
| `SINGLE_WHALE`           | WARN          | el mayor holder no-pool ≥ 10 % del supply                                   | RPC / Helius                   |
| `INSIDER_SHARE`          | WARN          | holders marcados `insider` ≥ 10 % del supply                                | RugCheck                       |
| `LP_UNLOCKED`            | DANGER        | LP bloqueada/quemada < 50 %                                                 | RugCheck                       |
| `MINT_AUTHORITY`         | DANGER        | el mint conserva autoridad de emisión (se puede inflar el supply)           | RPC (`getAccountInfo`)         |
| `FREEZE_AUTHORITY`       | WARN          | el mint conserva autoridad de congelar cuentas                              | RPC                            |
| `RUGCHECK:<riesgo>`      | DANGER        | cualquier riesgo que RugCheck marca `level: danger`                         | RugCheck                       |
| `WHALE_SELL`             | WARN          | un holder del top baja ≥ 20 % su saldo entre snapshots                      | diff de snapshots              |
| `WHALE_EXIT`             | DANGER        | un holder del top baja ≥ 90 % su saldo                                      | diff de snapshots              |
| `WHALE_LEFT_TOP`         | WARN          | un holder desaparece del top observado (no prueba venta total)              | diff de snapshots              |
| `LIQUIDITY_DROP`         | DANGER        | liquidez del pool cae ≥ 25 % respecto al snapshot anterior                  | DexScreener                    |
| `PRICE_DROP_1H` / `_24H` | WARN          | precio ≤ −20 % en 1 h / ≤ −40 % en 24 h                                     | DexScreener                    |
| `SELL_PRESSURE_1H`       | WARN          | ventas/compras ≥ 1,5 en la última hora (mín. 20 transacciones)              | DexScreener                    |
| `THIN_LIQUIDITY`         | WARN          | liquidez < 2 % del market cap                                               | DexScreener                    |
| `POSITION_VS_LIQUIDITY`  | WARN          | tu posición ≥ 10 % de la liquidez del pool (salir de golpe mueve el precio) | DexScreener + `positionTokens` |

Nivel del token: `PELIGRO` si hay alguna señal DANGER, `ATENCION` si solo hay WARN, `OK` si no hay
ninguna. Los umbrales viven en `tokens.json → thresholds`.

Movimientos que también se registran pero no alertan: `WHALE_ACCUMULATE` (sube ≥ 20 %) y
`NEW_WHALE` (entra en el top).

## Cómo usar las señales (reglas, no predicciones)

Nadie puede decirte con certeza cuándo vender. Lo que sí se puede es fijar de antemano qué
condiciones observables te hacen actuar, y dejar que el script te avise cuando ocurran. Propuesta
de reglas, ordenadas por gravedad; ajústalas a tu criterio:

1. **`MINT_AUTHORITY`, `LP_UNLOCKED` o `RUGCHECK:*` en DANGER** → el riesgo es estructural (se puede
   inflar el supply o retirar la liquidez). No depende de lo que hagan otros holders.
2. **`LIQUIDITY_DROP` + `WHALE_EXIT` en el mismo snapshot** → alguien grande ha salido y el pool ha
   perdido profundidad. Es la combinación en la que una salida posterior sufre más deslizamiento.
3. **`WHALE_SELL` / `WHALE_LEFT_TOP` repetidos en varios snapshots seguidos** → distribución
   sostenida por parte del top. Un solo `WHALE_SELL` aislado puede ser rebalanceo; la repetición no.
4. **`SELL_PRESSURE_1H` + `PRICE_DROP_1H`** → presión vendedora ya reflejada en precio. Por sí solas
   son ruido habitual en memecoins; combinadas con 2 o 3 pesan más.
5. **`POSITION_VS_LIQUIDITY`** → no es una señal de vender, es una señal de **cómo** vender: si tu
   posición es una fracción grande del pool, la salida debe ser escalonada (varias órdenes pequeñas)
   o el precio de ejecución será mucho peor que el que ves en pantalla.
6. **`TOP10_CONCENTRATION` / `SINGLE_WHALE` / `INSIDER_SHARE`** → contexto, no gatillo. Dicen cuánto
   daño puede hacer una sola wallet si decide vender. Un token con estas señales merece un
   `--interval` más corto.

Lo que el script **no** puede afirmar: la intención de una wallet, si dos wallets son la misma
persona (salvo lo que RugCheck marque como insider) ni si una bajada va a continuar.

## Cadenas: qué se analiza en cada una

El análisis de **ballenas/holders** usa el RPC de Solana y RugCheck, así que **solo funciona en
Solana**. Un token EVM (dirección `0x…` + 40 hex: Ethereum, Base, BSC, Arbitrum…) obtiene únicamente
las señales de mercado de DexScreener; su campo `holderSource` lo dice explícitamente y su nivel
nunca se basa en concentración de holders.

El formato de la dirección distingue la familia de cadena (`detectChain`), pero **no** dice en cuál
de las cadenas EVM vive el token: eso lo decide el par más líquido que devuelve DexScreener.

Un token sin ningún dato observado se marca **`SIN DATOS`**, nunca `OK`. `OK` significa
"se obtuvieron datos y ninguna regla saltó".

## Tokens del portfolio (captura 2026-09-19)

`tokens.json` trae los 11 tokens de la captura de posiciones con su cantidad (`positionTokens`),
más SPAWN. Cuatro direcciones las facilitó el operador el 2026-09-19 y **no han podido verificarse
contra la red en esa sesión** (política de salida bloqueada):

| Token   | Dirección                                      | Cadena | Análisis de ballenas |
| ------- | ---------------------------------------------- | ------ | -------------------- |
| ROUTER  | `6SjVTj1VGwFSXn7wEjwFm77LvACeTqB7sQUebYKX8Ds5` | Solana | sí                   |
| SPAWN   | `pC9Wo6oHLJx2Vwrvrtpj64mRHQPFYwvGSr4eR2apump`  | Solana | sí                   |
| DOT     | `0x23a2847d772803f9efc64b4277b782b06296fe51`   | EVM    | no, solo mercado     |
| SURPLUS | `0xc52aedec3374422d7510e294cfaa90799595cba3`   | EVM    | no, solo mercado     |

Los otros siete mints siguen a `null` a propósito: un símbolo como `DOT`, `RICE` o `DREAM` lo comparten muchos
tokens y no hay forma de saber cuál es el tuyo sin el mint de tu wallet. El comando `resolve` lista
los candidatos; el que aparece en tu wallet es el que hay que marcar `mintVerified: true`.

Los tokens de la lista "Robotics" de CoinGecko (VVV, COAI, AUKI, SPAWN, CASHCAT, VELO, ROBOT) no
están incluidos: esa lista no indica en qué cadena vive cada uno y este script solo cubre Solana.
Si alguno es de Solana, añádelo a `tokens.json` con su mint.

## Tests

```bash
node --test tests/unit/whale-watch-lib.test.ts
```
