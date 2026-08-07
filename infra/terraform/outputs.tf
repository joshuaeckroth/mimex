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

output "hosted_zone_name_servers" {
  description = "Name servers to configure at the registrar when Terraform creates the hosted zone"
  value       = var.create_hosted_zone ? aws_route53_zone.root[0].name_servers : []
}
