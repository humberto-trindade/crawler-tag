INSERT INTO templates (id, name, version, data, parent_template_id, created_by)
VALUES
(
  '11111111-1111-4111-8111-111111111111',
  'Pessoa Fisica - Seguro Auto',
  1,
  '{
    "keys": [
      { "key": "full_name", "value": "Maria Teste", "matchers": { "attributes": ["nome", "full_name"], "labels": ["nome completo"] } },
      { "key": "email", "value": "maria.teste@example.test", "matchers": { "attributes": ["email", "e-mail"], "types": ["email"], "autocomplete": ["email"] } },
      { "key": "phone", "value": "11999990000", "matchers": { "attributes": ["telefone", "phone"], "types": ["tel"], "autocomplete": ["tel"] } },
      { "key": "cep", "value": "01311000", "matchers": { "attributes": ["cep", "postal_code"], "autocomplete": ["postal-code"] } }
    ]
  }'::jsonb,
  NULL,
  'system-seed'
),
(
  '22222222-2222-4222-8222-222222222222',
  'Pessoa Juridica - Seguro Empresarial',
  1,
  '{
    "keys": [
      { "key": "company_name", "value": "Empresa Teste LTDA", "matchers": { "attributes": ["razao_social", "company_name"], "labels": ["razao social"] } },
      { "key": "cnpj", "value": "12345678000195", "matchers": { "attributes": ["cnpj"], "labels": ["cnpj"] } },
      { "key": "email", "value": "contato.empresa@example.test", "matchers": { "attributes": ["email"], "types": ["email"] } },
      { "key": "phone", "value": "1133334444", "matchers": { "attributes": ["telefone"], "types": ["tel"] } }
    ]
  }'::jsonb,
  NULL,
  'system-seed'
)
ON CONFLICT (id) DO NOTHING;
