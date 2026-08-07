# Mimex deployer identity

`mimex-deployer-policy.json` is the main inline policy used by the dedicated
`mimex-deployer` IAM user. `mimex-keypair-policy.json` is the source for the
customer-managed `MimexKeyPairManagement` policy. The user also needs the AWS-managed
`SignInLocalDevelopmentAccess` policy so `aws login` can provide temporary
CLI credentials without an access key, plus `IAMUserChangePassword` so the
user can complete the required first-login password reset.

## One-time console password

Run this from a shell that is authenticated as an account administrator:

```bash
read -rsp "Temporary IAM password: " IAM_TEMP_PASSWORD; echo
aws iam create-login-profile \
  --user-name mimex-deployer \
  --password "$IAM_TEMP_PASSWORD" \
  --password-reset-required
unset IAM_TEMP_PASSWORD
```

Sign in to the AWS console once as `mimex-deployer` and replace the temporary
password when prompted.

## Short-term CLI login

```bash
aws logout --all
aws login --profile mimex-deployer
aws sts get-caller-identity --profile mimex-deployer
```

The resulting ARN should end with `user/mimex-deployer`, not `root`.

Use the profile for Terraform and the release scripts:

```bash
export AWS_PROFILE=mimex-deployer
```

Do not create an IAM access key for this user.
