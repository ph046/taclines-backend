import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "TacLines AI Backend",
    route: "/calibrate"
  });
});

app.post("/calibrate", async (req, res) => {
  try {
    const { image_base64, game, task } = req.body || {};

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        confidence: 0,
        table: null,
        cueBall: null,
        balls: [],
        pockets: [],
        message: "OPENAI_API_KEY ausente no Render"
      });
    }

    if (!image_base64 || typeof image_base64 !== "string") {
      return res.status(400).json({
        ok: false,
        confidence: 0,
        table: null,
        cueBall: null,
        balls: [],
        pockets: [],
        message: "image_base64 ausente"
      });
    }

    const cleanBase64 = image_base64
      .replace(/^data:image\/\w+;base64,/, "")
      .replace(/\s/g, "");

    const imageUrl = `data:image/jpeg;base64,${cleanBase64}`;

    console.log("Recebida imagem para calibrar:", {
      game: game || "unknown",
      task: task || "unknown",
      base64Length: cleanBase64.length
    });

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Você é um calibrador visual para um app Android de sinuca 8 Ball Pool. " +
                "Analise UM print da tela do jogo e retorne coordenadas em pixels da imagem recebida. " +
                "Ignore HUD, botões, texto, menu, barra lateral, barra de força, avatar, nome do jogador e taco. " +
                "Use somente a área jogável da mesa verde e os objetos dentro dela. " +
                "Se a mesa estiver claramente visível, retorne ok=true mesmo que algumas coordenadas sejam aproximadas. " +
                "Use confidence entre 0.45 e 0.70 para calibração aproximada. " +
                "Use confidence acima de 0.70 somente quando a mesa, bola branca, bolas e caçapas estiverem bem localizadas. " +
                "Só retorne ok=false se não conseguir ver a mesa ou não conseguir localizar a bola branca. " +
                "Não invente bolas fora da mesa. Não conte bolas do HUD superior. Não conte ícones ou botões. " +
                "O objetivo é calibrar posições para cálculo matemático de tacadas."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Retorne somente JSON conforme o schema. " +
                "As coordenadas devem ser em pixels da imagem recebida. " +
                "table deve ser o retângulo interno jogável da mesa verde, sem incluir madeira/borda/HUD. " +
                "cueBall deve ser a bola branca real que está dentro da mesa. " +
                "balls devem ser as bolas alvo dentro da mesa, excluindo a bola branca. " +
                "pockets devem ser os centros aproximados das caçapas reais da mesa. " +
                "Se alguma caçapa estiver parcialmente coberta pela borda, estime o centro. " +
                "Se a calibração for aproximada mas útil, retorne ok=true com confidence entre 0.45 e 0.70 e explique em message."
            },
            {
              type: "input_image",
              image_url: imageUrl
            }
          ]
        }
      ],
      temperature: 0,
      text: {
        format: {
          type: "json_schema",
          name: "pool_calibration",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "ok",
              "confidence",
              "table",
              "cueBall",
              "balls",
              "pockets",
              "message"
            ],
            properties: {
              ok: {
                type: "boolean"
              },
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
                  {
                    type: "null"
                  }
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
                  {
                    type: "null"
                  }
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
              message: {
                type: "string"
              }
            }
          }
        }
      }
    });

    const text = response.output_text;

    if (!text || typeof text !== "string") {
      console.error("Resposta sem output_text:", JSON.stringify(response, null, 2));

      return res.status(500).json({
        ok: false,
        confidence: 0,
        table: null,
        cueBall: null,
        balls: [],
        pockets: [],
        message: "IA não retornou JSON"
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      console.error("Erro JSON.parse:", parseErr);
      console.error("Texto recebido:", text);

      return res.status(500).json({
        ok: false,
        confidence: 0,
        table: null,
        cueBall: null,
        balls: [],
        pockets: [],
        message: "IA retornou JSON inválido"
      });
    }

    const normalized = normalizeCalibration(parsed);

    console.log("Calibração OK:", {
      ok: normalized.ok,
      confidence: normalized.confidence,
      balls: normalized.balls.length,
      pockets: normalized.pockets.length,
      message: normalized.message
    });

    return res.json(normalized);
  } catch (err) {
    console.error("Calibration error:", err);

    const message =
      err?.error?.message ||
      err?.message ||
      "Erro interno na calibração IA";

    return res.status(500).json({
      ok: false,
      confidence: 0,
      table: null,
      cueBall: null,
      balls: [],
      pockets: [],
      message
    });
  }
});

function normalizeCalibration(raw) {
  const ok = Boolean(raw?.ok);
  const confidence = clampNumber(raw?.confidence, 0, 1, 0);

  const table = normalizeTable(raw?.table);
  const cueBall = normalizeBall(raw?.cueBall, "white");

  const balls = Array.isArray(raw?.balls)
    ? raw.balls
        .map((b) => normalizeBall(b, ""))
        .filter((b) => b !== null)
    : [];

  const pockets = Array.isArray(raw?.pockets)
    ? raw.pockets
        .map((p) => normalizePoint(p))
        .filter((p) => p !== null)
    : [];

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

function clampNumber(value, min, max, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, n));
}

app.listen(PORT, () => {
  console.log(`TacLines AI Backend rodando na porta ${PORT}`);
});
