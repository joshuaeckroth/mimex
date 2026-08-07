data "aws_route53_zone" "root" {
  count        = var.create_hosted_zone ? 0 : 1
  name         = var.hosted_zone_name
  private_zone = false
}

resource "aws_route53_zone" "root" {
  count = var.create_hosted_zone ? 1 : 0
  name  = var.hosted_zone_name

  tags = local.common_tags
}

data "aws_vpc" "default" {
  count   = var.vpc_id == "" ? 1 : 0
  default = true
}

locals {
  vpc_id = var.vpc_id != "" ? var.vpc_id : data.aws_vpc.default[0].id
}

data "aws_subnets" "selected" {
  count = var.subnet_id == "" ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

locals {
  name              = "${var.project_name}-${var.environment}"
  zone_name         = trimsuffix(var.hosted_zone_name, ".")
  hosted_zone_id    = var.create_hosted_zone ? aws_route53_zone.root[0].zone_id : data.aws_route53_zone.root[0].zone_id
  ami_ssm_parameter = var.instance_arch == "arm64" ? "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64" : "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
  subnet_id         = var.subnet_id != "" ? var.subnet_id : sort(data.aws_subnets.selected[0].ids)[0]
  common_tags = merge({
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }, var.tags)
}

data "aws_ssm_parameter" "al2023_ami" {
  name = local.ami_ssm_parameter
}

resource "aws_security_group" "app" {
  name        = "${local.name}-app-sg"
  description = "Security group for Mimex single-host deployment"
  vpc_id      = local.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  dynamic "ingress" {
    for_each = var.ssh_cidr == "" ? [] : [var.ssh_cidr]

    content {
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name}-app-sg"
  })
}

resource "aws_iam_role" "ec2" {
  name = "${local.name}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect = "Allow",
      Principal = {
        Service = "ec2.amazonaws.com"
      },
      Action = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${local.name}-ec2-profile"
  role = aws_iam_role.ec2.name

  tags = local.common_tags
}

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = var.instance_type
  subnet_id                   = local.subnet_id
  vpc_security_group_ids      = [aws_security_group.app.id]
  key_name                    = var.ssh_key_name != "" ? var.ssh_key_name : null
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  associate_public_ip_address = true
  user_data_replace_on_change = true

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_size_gb
    encrypted   = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  user_data = <<-EOF
              #!/bin/bash
              set -euxo pipefail

              dnf update -y
              dnf install -y docker

              systemctl enable --now docker
              usermod -aG docker ec2-user || true

              if ! docker compose version >/dev/null 2>&1; then
                dnf install -y docker-compose-plugin || true
              fi

              if ! docker compose version >/dev/null 2>&1; then
                mkdir -p /usr/local/lib/docker/cli-plugins
                ARCH="$(uname -m)"
                if [ "$ARCH" = "x86_64" ]; then
                  COMPOSE_ARCH="x86_64"
                elif [ "$ARCH" = "aarch64" ]; then
                  COMPOSE_ARCH="aarch64"
                else
                  COMPOSE_ARCH="$ARCH"
                fi
                curl -fsSL "https://github.com/docker/compose/releases/download/${var.docker_compose_version}/docker-compose-linux-$${COMPOSE_ARCH}" -o /usr/local/lib/docker/cli-plugins/docker-compose
                chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
              fi

              mkdir -p /opt/mimex/data/workspaces

              cat > /etc/systemd/system/mimex-compose.service <<'UNIT'
              [Unit]
              Description=Mimex Docker Compose
              Requires=docker.service
              After=docker.service network-online.target
              ConditionPathExists=/opt/mimex/docker-compose.yml

              [Service]
              Type=oneshot
              WorkingDirectory=/opt/mimex
              ExecStart=/usr/bin/docker compose up -d --remove-orphans
              ExecStop=/usr/bin/docker compose down
              RemainAfterExit=yes
              TimeoutStartSec=0

              [Install]
              WantedBy=multi-user.target
              UNIT

              systemctl daemon-reload
              systemctl enable mimex-compose
              EOF

  tags = merge(local.common_tags, {
    Name = "${local.name}-app"
  })
}

resource "aws_eip" "app" {
  domain = "vpc"

  tags = merge(local.common_tags, {
    Name = "${local.name}-eip"
  })
}

resource "aws_eip_association" "app" {
  instance_id   = aws_instance.app.id
  allocation_id = aws_eip.app.id
}

resource "aws_route53_record" "root_a" {
  zone_id         = local.hosted_zone_id
  name            = local.zone_name
  type            = "A"
  ttl             = 300
  records         = [aws_eip.app.public_ip]
  allow_overwrite = true
}
