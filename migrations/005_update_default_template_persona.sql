UPDATE templates
SET data = '{
  "keys": [
    {
      "key": "full_name",
      "value": "Maria Teste",
      "matchers": {
        "attributes": ["nome", "full_name"],
        "labels": ["nome completo"]
      }
    },
    {
      "key": "email",
      "value": "maria.teste@example.test",
      "matchers": {
        "attributes": ["email", "e-mail"],
        "types": ["email"],
        "autocomplete": ["email"]
      }
    },
    {
      "key": "phone",
      "value": "11999990000",
      "matchers": {
        "attributes": ["telefone", "phone", "celular"],
        "types": ["tel"],
        "autocomplete": ["tel"]
      }
    },
    {
      "key": "cep",
      "value": "01311000",
      "matchers": {
        "attributes": ["cep", "postal_code", "zipcode", "zip_code"],
        "labels": ["cep", "codigo postal"],
        "autocomplete": ["postal-code"]
      }
    },
    {
      "key": "pcf",
      "value": "00000000000",
      "matchers": {
        "attributes": ["pcf", "documento", "doc"],
        "labels": ["pcf", "documento"],
        "placeholders": ["pcf"]
      }
    }
  ]
}'::jsonb
WHERE id = '11111111-1111-4111-8111-111111111111';
