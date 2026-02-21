output "site_url" {
  description = "Primary HTTPS URL"
  value       = "https://${trimsuffix(var.hosted_zone_name, ".")}"
}

output "instance_id" {
  description = "EC2 instance id"
  value       = aws_instance.app.id
}

output "instance_public_ip" {
  description = "Elastic IP address of the app host"
  value       = aws_eip.app.public_ip
}

output "ssh_user" {
  description = "Default SSH user for Amazon Linux"
  value       = "ec2-user"
}

output "api_ecr_repository_url" {
  description = "ECR repository URL for API image"
  value       = aws_ecr_repository.api.repository_url
}

output "web_ecr_repository_url" {
  description = "ECR repository URL for web image"
  value       = aws_ecr_repository.web.repository_url
}
