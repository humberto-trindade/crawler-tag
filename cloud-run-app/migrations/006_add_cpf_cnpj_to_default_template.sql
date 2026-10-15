WITH current_template AS (
  SELECT
    id,
    COALESCE(data->'keys', '[]'::jsonb) AS keys
  FROM templates
  WHERE id = '11111111-1111-4111-8111-111111111111'
),
extended AS (
  SELECT
    id,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(keys) AS item WHERE item->>'key' = 'cpf'
      ) THEN keys
      ELSE keys || '[
        {
          "key": "cpf",
          "value": "11144477735",
          "matchers": {
            "attributes": ["cpf", "documento", "doc", "nr_cpf"],
            "labels": ["cpf", "documento"],
            "placeholders": ["cpf"]
          }
        }
      ]'::jsonb
    END AS keys_with_cpf
  FROM current_template
),
extended_2 AS (
  SELECT
    id,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(keys_with_cpf) AS item WHERE item->>'key' = 'cnpj'
      ) THEN keys_with_cpf
      ELSE keys_with_cpf || '[
        {
          "key": "cnpj",
          "value": "11222333000181",
          "matchers": {
            "attributes": ["cnpj", "nr_cnpj", "documento_empresa"],
            "labels": ["cnpj"],
            "placeholders": ["cnpj"]
          }
        }
      ]'::jsonb
    END AS final_keys
  FROM extended
)
UPDATE templates t
SET data = jsonb_set(COALESCE(t.data, '{}'::jsonb), '{keys}', e2.final_keys)
FROM extended_2 e2
WHERE t.id = e2.id;
