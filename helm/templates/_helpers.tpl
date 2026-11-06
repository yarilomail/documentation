{{- define "yarilo-docs.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "yarilo-docs.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "yarilo-docs.labels" -}}
app.kubernetes.io/name: {{ include "yarilo-docs.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "yarilo-docs.selectorLabels" -}}
app.kubernetes.io/name: {{ include "yarilo-docs.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
