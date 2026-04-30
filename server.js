import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "15mb" }));

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

    const imageUrl = `data:image/jpeg;base64,${image_base64}`;

    const response = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Você é um calibrador visual para um app de sinuca 8 Ball Pool. " +
                "Sua função é analisar UM print da tela do jogo e retornar coordenadas em pixels da imagem original. " +
                "Não invente dados. Se não tiver certeza, use confidence baixo. " +
                "Ignore HUD, botões, taco, barra de força, texto, menu e elementos fora da mesa. " +
                "Detecte apenas a área jogável da mesa, caçapas, bola branca e bolas dentro da mesa."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Calibre esta imagem para mira automática. Retorne somente JSON conforme o schema. " +
                "Coordenadas devem ser em pixels da imagem inteira, não coordenadas relativas. " +
                "table é o retângulo interno jogável da mesa, não incluindo HUD. " +
                "cueBall é a bola branca real. " +
                "balls são as bolas alvo, excluindo a bola branca. " +
                "pockets são os centros aproximados das caçapas visíveis da mesa."
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
    const parsed = JSON.parse(text);

    return res.json(parsed);
  } catch (err) {
    console.error("Calibration error:", err);

    return res.status(500).json({
      ok: false,
      confidence: 0,
      table: null,
      cueBall: null,
      balls: [],
      pockets: [],
      message: "Erro interno na calibração IA"
    });
  }
});

app.listen(PORT, () => {
  console.log(`TacLines AI Backend rodando na porta ${PORT}`);
});
