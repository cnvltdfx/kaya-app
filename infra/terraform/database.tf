# RDS for MySQL, single-AZ in AZ A, on a Free plan instance class. (Aurora on the Free plan
# only supports express-configuration clusters, which Terraform can't create.)
# The subnet group spans A + B because RDS requires two AZs. The master password is
# generated and stored in Secrets Manager, encrypted with the project KMS key.

resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db"
  subnet_ids = [for s in aws_subnet.data : s.id]

  tags = { Name = "${var.project_name}-db-subnets" }
}

resource "aws_db_instance" "main" {
  identifier        = "${var.project_name}-db"
  engine            = "mysql"
  engine_version    = var.db_engine_version
  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage
  storage_type      = "gp2"
  db_name           = var.db_name
  username          = "kaya_admin"

  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.main.key_id

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  availability_zone      = local.az_a
  multi_az               = false
  publicly_accessible    = false

  storage_encrypted = true
  kms_key_id        = aws_kms_key.main.arn

  backup_retention_period    = var.db_backup_retention_days
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
  deletion_protection        = var.db_deletion_protection
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.project_name}-db-final"
}
