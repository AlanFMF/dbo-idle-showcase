export function paymentTypeFromForm(formData={}){
  const selected=formData?._selectedPaymentMethod;
  const candidates=[
    formData?.payment_type_id,
    formData?.payment_type,
    formData?.paymentType,
    formData?.paymentMethodType,
    typeof selected==='string'?selected:'',
    selected?.type,
    selected?.paymentType,
    selected?.payment_type_id
  ];
  for(const candidate of candidates){
    const value=String(candidate||'').trim().toLowerCase();
    if(['credit_card','prepaid_card','debit_card','bank_transfer'].includes(value))return value;
  }
  return '';
}
