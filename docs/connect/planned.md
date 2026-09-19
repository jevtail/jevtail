# Planned receivers

Each of these has one official "push out" mechanism. jevtail will add one receiver per row;
the pipeline behind it does not change.

| Platform | Push mechanism | Receiver | Write-back (judgments as a log stream) |
| --- | --- | --- | --- |
| AWS CloudWatch Logs | Subscription Filter → Kinesis Firehose HTTP endpoint (or Lambda) | `/in/cloudwatch` (Firehose batch, gzip + base64 records) | `PutLogEvents` into a `jevtail` log group so CloudWatch Alarms can key on `jev.severity` |
| Datadog | Log Forwarding → Custom Destination (HTTP) | `/in/datadog` | Logs intake API with `jev.*` attributes |
| Elasticsearch / OpenSearch | Logstash `http` output, or a Kafka topic | `/in/elastic` (bulk NDJSON) | index `jevtail-judgments` |
| Grafana Loki | no push; poll LogQL `{level=~"error|warn"}` | poller like the Supabase one | push API to a `jevtail` label set |
| OpenTelemetry Collector, Fluent Bit, Vector | OTLP/HTTP logs exporter | `/in/otlp` (one receiver covers all three agents) | OTLP back into the collector |
| Alertmanager / PagerDuty / Opsgenie | outgoing webhook | `/in/alert` (alert-level triage, pulls context from the store) | webhook onward with judgment fields |

The OTLP receiver is the highest-leverage one: it turns every collector-based pipeline into a
source without a per-vendor adapter.
