variable "APP_VERSION" {
  default = "dev"
}

variable "APP_REVISION" {
  default = "unknown"
}

target "common" {
  context    = "."
  dockerfile = "Dockerfile"
  args = {
    APP_VERSION  = APP_VERSION
    APP_REVISION = APP_REVISION
  }
}

target "app" {
  inherits = ["common"]
  target   = "runner"
  tags     = ["ai-project-os-ci/app:${APP_REVISION}"]
}

target "worker" {
  inherits = ["common"]
  target   = "worker"
  tags     = ["ai-project-os-ci/worker:${APP_REVISION}"]
}

target "migrate" {
  inherits = ["common"]
  target   = "migrate"
  tags     = ["ai-project-os-ci/migrate:${APP_REVISION}"]
}

target "performance-export" {
  inherits = ["common"]
  target   = "performance-export"
}

group "default" {
  targets = ["app", "worker", "migrate"]
}
