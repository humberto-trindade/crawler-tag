-- Add checkbox/handler fields discovered from execution 4018382b
-- These were marked as "unsupported_type" in ignored_fields

UPDATE templates
SET data = jsonb_set(
  data,
  '{keys}',
  data->'keys' || jsonb_build_array(
    jsonb_build_object(
      'key', 'ot-group-id-C0002',
      'value', 'on',
      'matchers', jsonb_build_object(
        'attributes', jsonb_build_array('ot-group-id-C0002'),
        'types', jsonb_build_array('checkbox')
      )
    ),
    jsonb_build_object(
      'key', 'ot-group-id-C0003',
      'value', 'on',
      'matchers', jsonb_build_object(
        'attributes', jsonb_build_array('ot-group-id-C0003'),
        'types', jsonb_build_array('checkbox')
      )
    ),
    jsonb_build_object(
      'key', 'ot-group-id-BG29',
      'value', 'on',
      'matchers', jsonb_build_object(
        'attributes', jsonb_build_array('ot-group-id-BG29'),
        'types', jsonb_build_array('checkbox')
      )
    ),
    jsonb_build_object(
      'key', 'vendor-search-handler',
      'value', 'active',
      'matchers', jsonb_build_object(
        'attributes', jsonb_build_array('vendor-search-handler'),
        'types', jsonb_build_array('button', 'button-click')
      )
    ),
    jsonb_build_object(
      'key', 'select-all-hosts-groups-handler',
      'value', 'clicked',
      'matchers', jsonb_build_object(
        'attributes', jsonb_build_array('select-all-hosts-groups-handler'),
        'types', jsonb_build_array('button', 'button-click')
      )
    ),
    jsonb_build_object(
      'key', 'select-all-vendor-groups-handler',
      'value', 'clicked',
      'matchers', jsonb_build_object(
        'attributes', jsonb_build_array('select-all-vendor-groups-handler'),
        'types', jsonb_build_array('button', 'button-click')
      )
    ),
    jsonb_build_object(
      'key', 'select-all-vendor-leg-handler',
      'value', 'clicked',
      'matchers', jsonb_build_object(
        'attributes', jsonb_build_array('select-all-vendor-leg-handler'),
        'types', jsonb_build_array('button', 'button-click')
      )
    )
  )
)
WHERE name LIKE 'Pessoa Fisica%' OR name LIKE 'Porto Seguro%' OR parent_template_id IS NULL;
