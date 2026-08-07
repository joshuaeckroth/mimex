variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name prefix"
  type        = string
  default     = "mimex"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "prod"
}

variable "hosted_zone_name" {
  description = "Route53 hosted zone name (root domain only)"
  type        = string
  default     = "mimex.dev"
}

variable "create_hosted_zone" {
  description = "Create and manage the public Route53 hosted zone instead of looking up an existing zone"
  type        = bool
  default     = false
}

variable "vpc_id" {
  description = "Existing VPC ID. When empty, use the region's default VPC."
  type        = string
  default     = ""
}

variable "subnet_id" {
  description = "Existing subnet ID. When empty, use the first subnet in the selected VPC."
  type        = string
  default     = ""
}

variable "instance_type" {
  description = "EC2 instance type. t4g.small is cheapest if your images are arm64-compatible."
  type        = string
  default     = "t4g.small"
}

variable "instance_arch" {
  description = "AMI architecture: arm64 for t4g, x86_64 for t3/t3a"
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.instance_arch)
    error_message = "instance_arch must be arm64 or x86_64."
  }
}

variable "root_volume_size_gb" {
  description = "Root volume size in GiB"
  type        = number
  default     = 30
}

variable "docker_compose_version" {
  description = "Docker Compose plugin version to install if the package manager plugin is unavailable"
  type        = string
  default     = "v5.0.1"
}

variable "ssh_key_name" {
  description = "Existing EC2 key pair name for SSH access"
  type        = string
  default     = ""
}

variable "ssh_cidr" {
  description = "CIDR allowed to SSH to the host. Set empty string to disable SSH ingress rule."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}
