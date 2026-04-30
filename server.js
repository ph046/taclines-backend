import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const PORT = process.env.PORT || 3000;
const MODEL = "gpt-4.1-mini";

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "TacLines AI Backend",
    routes: ["/calibrate", "/plan-shot", "/ai-play-step"]
  });
});

app.post("/calibrate", async (req, res) => {
  try {
    const imageUrl = getImageUrlFromRequest(req);

    const scene = await detectPoolScene(imageUrl, {
      mode: "calibrate"
    });

    const normalized = normalizeCalibration(scene);

    console.log("Calibração:", {
      ok: normalized.ok,
      confidence: normalized.confidence,
      balls: normalized.balls.length,
      pockets: normalized.pockets.length,
      message: normalized.message
    });

    return res.json(normalized);
  } catch (err) {
    console.error("Calibration error:", err);
    return res.status(500).json(emptyCalibration(getErrorMessage(err)));
  }
});

app.post("/plan-shot", async (req, res) => {
  try {
    const imageUrl = getImageUrlFromRequest(req);

    const sceneRaw = await detectPoolScene(imageUrl, {
      mode: "plan-shot"
    });

    const scene = normalizeCalibration(sceneRaw);

    if (!scene.ok || !scene.cueBall || scene.balls.length === 0) {
      return res.json(
        emptyShotPlan(
          scene.message || "IA não conseguiu localizar mesa, bola branca e bolas."
        )
      );
    }

    let pockets = scene.pockets;

    if (pockets.length < 4 && scene.table) {
      pockets = estimatePocketsFromTable(scene.table);
    }

    if (pockets.length < 4) {
      return res.json(emptyShotPlan("Caçapas insuficientes para calcular jogada."));
    }

    const plan = calculateBestShot({
      table: scene.table,
      cueBall: scene.cueBall,
      balls: scene.balls,
      pockets
    });

    console.log("Plan-shot:", {
      ok: plan.ok,
      confidence: plan.confidence,
      power: plan.power,
      message: plan.message
    });

    return res.json(plan);
  } catch (err) {
    console.error("Plan-shot error:", err);
    return res.status(500).json(emptyShotPlan(getErrorMessage(err)));
  }
});

app.post("/ai-play-step", async (req, res) => {
  try {
    const imageUrl = getImageUrlFromRequest(req);
    const stepIndex = Number(req.body?.step_index ?? 0);
    const maxSteps = Number(req.body?.max_steps ?? 5);

    const step = await detectAiPlayStep(imageUrl, {
      stepIndex,
      maxSteps
    });

    const normalized = normalizeAiPlayStep(step);

    console.log("AI Play Step:", {
      ok: normalized.ok,
      action: normalized.action,
      confidence: normalized.confidence,
      done: normalized.done,
      shouldShoot: normalized.shouldShoot,
      message: normalized.message
    });

    return res.json(normalized);
  } catch (err) {
    console.error("AI Play Step error:", err);
    return res.status(500).json(emptyAiPlayStep(getErrorMessage(err)));
  }
});

function getImageUrlFromRequest(req) {
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error("OPENAI_API_KEY ausente no Render");
    e.statusCode = 500;
    throw e;
  }

  const { image_base64, game, task } = req.body || {};

  if (!image_base64 || typeof image_base64 !== "string") {
    const e = new Error("image_base64 ausente");
    e.statusCode = 400;
    throw e;
  }

  const cleanBase64 = image_base64
    .replace(/^data:image\/\w+;base64,/, "")
    .replace(/\s/g, "");

  console.log("Imagem recebida:", {
    game: game || "unknown",
    task: task || "unknown",
    base64Length: cleanBase64.length
  });

  return `data:image/jpeg;base64,${cleanBase64}`;
}

async function detectPoolScene(imageUrl, options = {}) {
  const mode = options.mode || "calibrate";

  const response = await client.responses.create({
    model: MODEL,
    temperature: 0,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Você é um calibrador visual de sinuca 8 Ball Pool para um app Android. " +
              "Analise UM print da tela e retorne coordenadas em pixels da imagem recebida. " +
              "Ignore completamente HUD, botões, textos, nomes, avatar, barra de força, menu e taco. " +
              "Use apenas a mesa jogável, bolas dentro da mesa e caçapas. " +
              "Não conte bolas do HUD superior. Não conte ícones. Não conte efeitos visuais fora da mesa. " +
              "A mesa geralmente é uma área verde retangular com seis caçapas. " +
              "Se a mesa estiver visível e a bola branca estiver visível, retorne ok=true. " +
              "Use confidence 0.45 a 0.70 se for aproximado, e acima de 0.70 se estiver bem claro. " +
              "Só retorne ok=false se não conseguir ver a mesa ou a bola branca. " +
              "Retorne somente JSON seguindo o schema."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              (mode === "plan-shot"
                ? "Detecte a mesa, bola branca, bolas alvo e caçapas para o servidor calcular a melhor tacada. "
                : "Calibre a mesa, bola branca, bolas alvo e caçapas. ") +
              "table deve ser o retângulo interno jogável da mesa verde, sem borda/madeira/HUD. " +
              "cueBall é a bola branca real dentro da mesa. " +
              "balls são as bolas alvo dentro da mesa, excluindo a bola branca. " +
              "pockets são os centros aproximados das caçapas reais da mesa. " +
              "Se alguma caçapa estiver parcialmente escondida, estime o centro. " +
              "Coordenadas em pixels da imagem recebida."
          },
          {
            type: "input_image",
            image_url: imageUrl
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "pool_scene",
        strict: true,
        schema: sceneSchema()
      }
    }
  });

  const text = response.output_text;

  if (!text || typeof text !== "string") {
    console.error("Resposta sem output_text:", JSON.stringify(response, null, 2));
    throw new Error("IA não retornou JSON");
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("JSON inválido:", text);
    throw new Error("IA retornou JSON inválido");
  }
}

async function detectAiPlayStep(imageUrl, options = {}) {
  const stepIndex = Number.isFinite(options.stepIndex) ? options.stepIndex : 0;
  const maxSteps = Number.isFinite(options.maxSteps) ? options.maxSteps : 5;

  const response = await client.responses.create({
    model: MODEL,
    temperature: 0,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Você é o controlador visual de um app Android jogando sinuca 8 Ball Pool em modo offline. " +
              "Você recebe UM print atual da tela e deve decidir UM próximo passo. " +
              "Seu objetivo é jogar com segurança. " +
              "Ignore HUD, botões, texto, nomes, avatar, menus e elementos fora da mesa. " +
              "Use apenas a mesa, bolas, caçapas, taco e linha de mira visível do jogo. " +
              "Se a mira atual ainda NÃO estiver alinhada com uma tacada boa, retorne action='drag' com um micro movimento curto para ajustar a mira. " +
              "Se a mira atual JÁ estiver alinhada com uma tacada boa, retorne action='shoot' com gesto de puxar/soltar. " +
              "Se não conseguir ver a mesa, bola branca ou uma jogada clara, retorne action='stop'. " +
              "NÃO chute gestos gigantes. Ajustes de mira devem ser pequenos e controlados. " +
              "Use coordenadas em pixels da imagem recebida. " +
              "gesture.fromX/fromY e toX/toY devem ser coordenadas absolutas da tela. " +
              "Retorne somente JSON conforme schema."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `Este é o passo ${stepIndex + 1} de no máximo ${maxSteps}. ` +
              "Analise a mesa atual. " +
              "Se precisar ajustar mira, action='drag', done=false, shouldShoot=false. " +
              "Para action='drag', use movimento curto, normalmente entre 20 e 120 pixels. " +
              "Use o gesto sobre a região da bola branca/taco/área de mira, não no HUD. " +
              "Se a mira estiver boa para encaçapar uma bola, action='shoot', done=true, shouldShoot=true. " +
              "Para action='shoot', faça um gesto de força mais longo no sentido correto para bater. " +
              "Se a tela estiver confusa, action='stop', done=true. " +
              "Não use caçapas impossíveis, bancos ou jogadas muito cortadas. Priorize tacadas simples."
          },
          {
            type: "input_image",
            image_url: imageUrl
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "ai_play_step",
        strict: true,
        schema: aiPlayStepSchema()
      }
    }
  });

  const text = response.output_text;

  if (!text || typeof text !== "string") {
    console.error("AI step sem output_text:", JSON.stringify(response, null, 2));
    throw new Error("IA não retornou JSON no passo");
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("JSON inválido ai-play-step:", text);
    throw new Error("IA retornou JSON inválido no passo");
  }
}

function sceneSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["ok", "confidence", "table", "cueBall", "balls", "pockets", "message"],
    properties: {
      ok: { type: "boolean" },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      },
      table: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["x", "y", "w", "h"],
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" }
            }
          },
          { type: "null" }
        ]
      },
      cueBall: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["x", "y", "r", "color"],
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              r: { type: "number" },
              color: { type: "string" }
            }
          },
          { type: "null" }
        ]
      },
      balls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["x", "y", "r", "color"],
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            r: { type: "number" },
            color: { type: "string" }
          }
        }
      },
      pockets: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["x", "y"],
          properties: {
            x: { type: "number" },
            y: { type: "number" }
          }
        }
      },
      message: { type: "string" }
    }
  };
}

function aiPlayStepSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "ok",
      "action",
      "confidence",
      "gesture",
      "done",
      "shouldShoot",
      "message"
    ],
    properties: {
      ok: { type: "boolean" },
      action: {
        type: "string",
        enum: ["drag", "shoot", "stop", "fail", "none"]
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      },
      gesture: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["fromX", "fromY", "toX", "toY", "durationMs"],
            properties: {
              fromX: { type: "number" },
              fromY: { type: "number" },
              toX: { type: "number" },
              toY: { type: "number" },
              durationMs: { type: "number" }
            }
          },
          { type: "null" }
        ]
      },
      done: { type: "boolean" },
      shouldShoot: { type: "boolean" },
      message: { type: "string" }
    }
  };
}

function normalizeCalibration(raw) {
  const ok = Boolean(raw?.ok);
  const confidence = clampNumber(raw?.confidence, 0, 1, 0);

  const table = normalizeTable(raw?.table);
  const cueBall = normalizeBall(raw?.cueBall, "white");

  const balls = Array.isArray(raw?.balls)
    ? raw.balls
        .map((b) => normalizeBall(b, ""))
        .filter((b) => b !== null)
        .filter((b) => !sameBall(b, cueBall))
    : [];

  let pockets = Array.isArray(raw?.pockets)
    ? raw.pockets
        .map((p) => normalizePoint(p))
        .filter((p) => p !== null)
    : [];

  if (pockets.length < 4 && table) {
    pockets = estimatePocketsFromTable(table);
  }

  const hasBasicData =
    cueBall !== null &&
    balls.length > 0 &&
    pockets.length >= 4;

  return {
    ok: ok && hasBasicData,
    confidence,
    table,
    cueBall,
    balls,
    pockets,
    message: String(raw?.message || "")
  };
}

function normalizeAiPlayStep(raw) {
  const action = String(raw?.action || "fail").toLowerCase();
  const confidence = clampNumber(raw?.confidence, 0, 1, 0);
  const gesture = normalizeGesture(raw?.gesture);
  const done = Boolean(raw?.done);
  const shouldShoot = Boolean(raw?.shouldShoot);

  const actionNeedsGesture = action === "drag" || action === "shoot";

  return {
    ok: Boolean(raw?.ok) && confidence >= 0.35 && (!actionNeedsGesture || gesture !== null),
    action,
    confidence,
    gesture,
    done,
    shouldShoot,
    message: String(raw?.message || "")
  };
}

function normalizeGesture(g) {
  if (!g || typeof g !== "object") return null;

  const fromX = Number(g.fromX);
  const fromY = Number(g.fromY);
  const toX = Number(g.toX);
  const toY = Number(g.toY);
  const durationMs = Number(g.durationMs);

  if (
    !Number.isFinite(fromX) ||
    !Number.isFinite(fromY) ||
    !Number.isFinite(toX) ||
    !Number.isFinite(toY)
  ) {
    return null;
  }

  return {
    fromX: clampNumber(fromX, 0, 10000, 0),
    fromY: clampNumber(fromY, 0, 10000, 0),
    toX: clampNumber(toX, 0, 10000, 0),
    toY: clampNumber(toY, 0, 10000, 0),
    durationMs: clampNumber(durationMs, 60, 900, 220)
  };
}

function calculateBestShot({ table, cueBall, balls, pockets }) {
  const allBalls = [cueBall, ...balls];
  const radius = estimateBallRadius(cueBall, balls);

  let best = null;
  let bestScore = -Infinity;

  for (const target of balls) {
    for (const pocket of pockets) {
      const candidate = evaluateShot({
        table,
        cueBall,
        target,
        pocket,
        allBalls,
        radius
      });

      if (!candidate) continue;

      if (candidate.score > bestScore) {
        bestScore = candidate.score;
        best = candidate;
      }
    }
  }

  if (!best) {
    return emptyShotPlan("Sem tacada direta segura. Tente outra posição ou calibre novamente.");
  }

  const confidence = clampNumber(best.confidence, 0, 0.92, 0);

  if (confidence < 0.48) {
    return emptyShotPlan("Tacada calculada com confiança baixa.");
  }

  return {
    ok: true,
    confidence,
    cueBall: best.cueBall,
    targetBall: best.targetBall,
    pocket: best.pocket,
    ghostBall: best.ghostBall,
    pull: best.pull,
    power: best.power,
    message: best.message
  };
}

function evaluateShot({ table, cueBall, target, pocket, allBalls, radius }) {
  const tx = pocket.x - target.x;
  const ty = pocket.y - target.y;
  const targetToPocketLen = hypot(tx, ty);

  if (targetToPocketLen < radius * 3) return null;

  const pocketDir = normalize(tx, ty);
  if (!pocketDir) return null;

  const ghost = {
    x: target.x - pocketDir.x * radius * 2,
    y: target.y - pocketDir.y * radius * 2
  };

  if (table && !pointInsideTable(ghost, table, radius * 0.8)) return null;

  const cgx = ghost.x - cueBall.x;
  const cgy = ghost.y - cueBall.y;
  const cueToGhostLen = hypot(cgx, cgy);

  if (cueToGhostLen < radius * 3) return null;

  const cueDir = normalize(cgx, cgy);
  if (!cueDir) return null;

  const dot = clampNumber(cueDir.x * pocketDir.x + cueDir.y * pocketDir.y, -1, 1, 0);
  const cutAngle = Math.acos(dot) * 180 / Math.PI;

  if (cutAngle > 72) return null;
  if (dot < 0.30) return null;

  const cuePathClear = isSegmentClear({
    x1: cueBall.x,
    y1: cueBall.y,
    x2: ghost.x,
    y2: ghost.y,
    balls: allBalls,
    ignoreA: cueBall,
    ignoreB: target,
    clearance: radius * 1.65
  });

  if (!cuePathClear) return null;

  const targetPathClear = isSegmentClear({
    x1: target.x,
    y1: target.y,
    x2: pocket.x,
    y2: pocket.y,
    balls: allBalls,
    ignoreA: cueBall,
    ignoreB: target,
    clearance: radius * 1.25
  });

  if (!targetPathClear) return null;

  const railPenalty = table ? railRiskPenalty(ghost, table, radius) : 0;
  const pocketScore = pocketEaseScore(target, pocket, radius);
  const cutScore = cutEaseScore(cutAngle);
  const distanceScore = distanceEaseScore(cueToGhostLen + targetToPocketLen);
  const alignmentScore = clampNumber(dot, 0, 1, 0);

  const score =
    cutScore * 0.36 +
    pocketScore * 0.26 +
    distanceScore * 0.22 +
    alignmentScore * 0.16 -
    railPenalty;

  const confidence = clampNumber(score, 0, 0.92, 0);

  if (confidence < 0.48) return null;

  const power = estimatePower({
    cueToGhostLen,
    targetToPocketLen,
    cutAngle
  });

  const pullDistance = estimatePullDistance(power);
  const durationMs = estimateDuration(power);

  const pull = {
    fromX: cueBall.x,
    fromY: cueBall.y,
    toX: cueBall.x - cueDir.x * pullDistance,
    toY: cueBall.y - cueDir.y * pullDistance,
    durationMs
  };

  return {
    score,
    confidence,
    cueBall: normalizeShotBall(cueBall, "white"),
    targetBall: normalizeShotBall(target, target.color || ""),
    pocket: normalizeShotPoint(pocket),
    ghostBall: normalizeShotPoint(ghost),
    pull,
    power,
    message:
      `Alvo ${target.color || "bola"} para caçapa. ` +
      `Corte ${Math.round(cutAngle)}°, força ${Math.round(power * 100)}%.`
  };
}

function estimatePocketsFromTable(table) {
  const x1 = table.x;
  const y1 = table.y;
  const x2 = table.x + table.w;
  const y2 = table.y + table.h;
  const mx = (x1 + x2) / 2;

  const padX = table.w * 0.025;
  const padY = table.h * 0.035;

  return [
    { x: x1 + padX, y: y1 + padY },
    { x: mx, y: y1 + padY * 0.55 },
    { x: x2 - padX, y: y1 + padY },
    { x: x1 + padX, y: y2 - padY },
    { x: mx, y: y2 - padY * 0.55 },
    { x: x2 - padX, y: y2 - padY }
  ];
}

function estimateBallRadius(cueBall, balls) {
  const values = [cueBall?.r, ...balls.map((b) => b.r)]
    .filter((v) => Number.isFinite(v))
    .filter((v) => v >= 5 && v <= 35)
    .sort((a, b) => a - b);

  if (values.length === 0) return 13;

  return clampNumber(values[Math.floor(values.length / 2)], 8, 24, 13);
}

function estimatePower({ cueToGhostLen, targetToPocketLen, cutAngle }) {
  const raw =
    0.18 +
    cueToGhostLen / 950 +
    targetToPocketLen / 1250 +
    cutAngle / 210;

  return clampNumber(raw, 0.28, 0.86, 0.5);
}

function estimatePullDistance(power) {
  return clampNumber(80 + power * 260, 110, 340, 190);
}

function estimateDuration(power) {
  return Math.round(clampNumber(160 + power * 280, 160, 450, 260));
}

function cutEaseScore(angle) {
  if (angle <= 10) return 0.98;
  if (angle <= 22) return 0.88;
  if (angle <= 36) return 0.74;
  if (angle <= 52) return 0.56;
  if (angle <= 65) return 0.42;
  return 0.25;
}

function pocketEaseScore(target, pocket, radius) {
  const d = hypot(pocket.x - target.x, pocket.y - target.y);

  if (d < radius * 9) return 0.95;
  if (d < radius * 18) return 0.82;
  if (d < radius * 30) return 0.66;
  if (d < radius * 44) return 0.50;
  return 0.35;
}

function distanceEaseScore(d) {
  if (d < 300) return 0.95;
  if (d < 520) return 0.80;
  if (d < 760) return 0.62;
  if (d < 980) return 0.45;
  return 0.30;
}

function railRiskPenalty(point, table, radius) {
  const left = Math.abs(point.x - table.x);
  const right = Math.abs(table.x + table.w - point.x);
  const top = Math.abs(point.y - table.y);
  const bottom = Math.abs(table.y + table.h - point.y);

  const minDist = Math.min(left, right, top, bottom);

  if (minDist < radius * 1.2) return 0.22;
  if (minDist < radius * 2.0) return 0.12;
  return 0;
}

function isSegmentClear({ x1, y1, x2, y2, balls, ignoreA, ignoreB, clearance }) {
  for (const ball of balls) {
    if (sameBall(ball, ignoreA) || sameBall(ball, ignoreB)) continue;

    const hit = distancePointToSegment(ball.x, ball.y, x1, y1, x2, y2);

    if (hit.distance < clearance && hit.t > 0.04 && hit.t < 0.96) {
      return false;
    }
  }

  return true;
}

function distancePointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;

  if (len2 <= 0.0001) {
    return {
      distance: hypot(px - x1, py - y1),
      t: 0
    };
  }

  const rawT = ((px - x1) * dx + (py - y1) * dy) / len2;
  const t = clampNumber(rawT, 0, 1, 0);

  const projX = x1 + t * dx;
  const projY = y1 + t * dy;

  return {
    distance: hypot(px - projX, py - projY),
    t
  };
}

function pointInsideTable(p, table, margin = 0) {
  return (
    p.x >= table.x + margin &&
    p.x <= table.x + table.w - margin &&
    p.y >= table.y + margin &&
    p.y <= table.y + table.h - margin
  );
}

function normalize(x, y) {
  const len = hypot(x, y);
  if (len <= 0.0001) return null;

  return {
    x: x / len,
    y: y / len
  };
}

function hypot(x, y) {
  return Math.sqrt(x * x + y * y);
}

function sameBall(a, b) {
  if (!a || !b) return false;

  const r = Math.max(a.r || 12, b.r || 12);

  return hypot(a.x - b.x, a.y - b.y) < r * 0.55;
}

function normalizeTable(t) {
  if (!t || typeof t !== "object") return null;

  return {
    x: clampNumber(t.x, 0, 10000, 0),
    y: clampNumber(t.y, 0, 10000, 0),
    w: clampNumber(t.w, 1, 10000, 1),
    h: clampNumber(t.h, 1, 10000, 1)
  };
}

function normalizeBall(b, fallbackColor) {
  if (!b || typeof b !== "object") return null;

  const x = Number(b.x);
  const y = Number(b.y);
  const r = Number(b.r);

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return {
    x: clampNumber(x, 0, 10000, 0),
    y: clampNumber(y, 0, 10000, 0),
    r: clampNumber(r, 5, 35, 12),
    color: String(b.color || fallbackColor || "")
  };
}

function normalizePoint(p) {
  if (!p || typeof p !== "object") return null;

  const x = Number(p.x);
  const y = Number(p.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return {
    x: clampNumber(x, 0, 10000, 0),
    y: clampNumber(y, 0, 10000, 0)
  };
}

function normalizeShotBall(b, fallbackColor) {
  return {
    x: clampNumber(b.x, 0, 10000, 0),
    y: clampNumber(b.y, 0, 10000, 0),
    r: clampNumber(b.r, 5, 35, 12),
    color: String(b.color || fallbackColor || "")
  };
}

function normalizeShotPoint(p) {
  return {
    x: clampNumber(p.x, 0, 10000, 0),
    y: clampNumber(p.y, 0, 10000, 0)
  };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, n));
}

function emptyCalibration(message) {
  return {
    ok: false,
    confidence: 0,
    table: null,
    cueBall: null,
    balls: [],
    pockets: [],
    message: message || "Falha na calibração"
  };
}

function emptyShotPlan(message) {
  return {
    ok: false,
    confidence: 0,
    cueBall: null,
    targetBall: null,
    pocket: null,
    ghostBall: null,
    pull: null,
    power: 0,
    message: message || "Sem plano de tacada"
  };
}

function emptyAiPlayStep(message) {
  return {
    ok: false,
    action: "fail",
    confidence: 0,
    gesture: null,
    done: true,
    shouldShoot: false,
    message: message || "Falha no passo da IA"
  };
}

function getErrorMessage(err) {
  return (
    err?.error?.message ||
    err?.message ||
    "Erro interno"
  );
}

app.listen(PORT, () => {
  console.log(`TacLines AI Backend rodando na porta ${PORT}`);
});
