# VPC with public (ALB, NAT), private app (ASG) and private data (Aurora) subnets.

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.project_name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${var.project_name}-igw" }
}

# ---- Public subnets: A hosts the NAT Gateway; A + B host the ALB

resource "aws_subnet" "public" {
  for_each = {
    a = { az = local.az_a, cidr = var.public_subnet_cidrs[0] }
    b = { az = local.az_b, cidr = var.public_subnet_cidrs[1] }
  }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.value.az
  cidr_block        = each.value.cidr

  tags = { Name = "${var.project_name}-public-${each.key}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.project_name}-public-rt" }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# ---- NAT instance (public subnet A). Replaces a NAT Gateway to stay within the Free plan.
# Single instance, not highly available: if it stops, the API servers lose outbound access.

resource "aws_instance" "nat" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = var.nat_instance_type
  subnet_id                   = aws_subnet.public["a"].id
  vpc_security_group_ids      = [aws_security_group.nat.id]
  associate_public_ip_address = true
  source_dest_check           = false
  iam_instance_profile        = aws_iam_instance_profile.nat.name

  user_data                   = templatefile("${path.module}/nat_user_data.sh.tftpl", { vpc_cidr = var.vpc_cidr })
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_size
    encrypted   = true
  }

  tags = { Name = "${var.project_name}-nat" }

  lifecycle {
    ignore_changes = [ami]
  }

  depends_on = [aws_internet_gateway.main]
}

# ---- Private app subnet (AZ A): API servers, outbound via the NAT instance for ECR, SSM, S3, Secrets Manager

resource "aws_subnet" "app" {
  vpc_id            = aws_vpc.main.id
  availability_zone = local.az_a
  cidr_block        = var.app_subnet_cidr

  tags = { Name = "${var.project_name}-app-a" }
}

resource "aws_route_table" "app" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block           = "0.0.0.0/0"
    network_interface_id = aws_instance.nat.primary_network_interface_id
  }

  tags = { Name = "${var.project_name}-app-rt" }
}

resource "aws_route_table_association" "app" {
  subnet_id      = aws_subnet.app.id
  route_table_id = aws_route_table.app.id
}

# ---- Private data subnets (A + B): Aurora. No route to the internet.

resource "aws_subnet" "data" {
  for_each = {
    a = { az = local.az_a, cidr = var.data_subnet_cidrs[0] }
    b = { az = local.az_b, cidr = var.data_subnet_cidrs[1] }
  }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.value.az
  cidr_block        = each.value.cidr

  tags = { Name = "${var.project_name}-data-${each.key}" }
}

resource "aws_route_table" "data" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${var.project_name}-data-rt" }
}

resource "aws_route_table_association" "data" {
  for_each = aws_subnet.data

  subnet_id      = each.value.id
  route_table_id = aws_route_table.data.id
}
