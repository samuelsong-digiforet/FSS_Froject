import { useState, useEffect, useCallback } from 'react';
import { usersApi, UserItem, CreateUserPayload, UpdateUserPayload } from '@/api/users';
import { usePermission } from '@/hooks/usePermission';

const EyeIcon = ({ show }: { show: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
    {show ? (
      <>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ) : (
      <>
        <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
        <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </>
    )}
  </svg>
);

function ApprovalToggle({ value, onChange, disabled = false }: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => !disabled && onChange(true)}
        className={`flex-1 py-2.5 text-sm rounded-lg border transition-colors
          ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}
          ${value
            ? 'bg-[#2d4a7a] text-white border-[#2d4a7a]'
            : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}
      >
        승인
      </button>
      <button
        type="button"
        onClick={() => !disabled && onChange(false)}
        className={`flex-1 py-2.5 text-sm rounded-lg border transition-colors
          ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}
          ${!value
            ? 'bg-[#2d4a7a] text-white border-[#2d4a7a]'
            : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}
      >
        미승인
      </button>
    </div>
  );
}

function Alert({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70]">
      <div className="bg-white rounded-lg w-full max-w-sm mx-4 shadow-xl p-6">
        <p className="text-gray-700 text-sm text-center whitespace-pre-line mb-6">{message}</p>
        <div className="flex justify-center">
          <button
            onClick={onClose}
            className="px-8 py-2 text-sm bg-[#2d4a7a] text-white rounded-lg hover:bg-[#1e3a6a]"
          >
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

const PHONE_REGEX = /^01[016789]-\d{3,4}-\d{4}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[a-zA-Z0-9_]{4,20}$/;

const formatPhone = (value: string) => {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
};

type FormErrors = Partial<Record<'username' | 'password' | 'fullName' | 'email' | 'department' | 'position' | 'phone', string>>;

function validateCreate(form: CreateUserPayload): FormErrors {
  const e: FormErrors = {};
  if (!form.username) e.username = '아이디를 입력하세요.';
  else if (!USERNAME_REGEX.test(form.username)) e.username = '4~20자 영문·숫자·_ 만 허용됩니다.';
  if (!form.password) e.password = '비밀번호를 입력하세요.';
  else if (form.password.length < 8) e.password = '8자 이상 입력하세요.';
  if (!form.department) e.department = '부서를 입력하세요.';
  if (!form.position) e.position = '직급을 입력하세요.';
  if (!form.fullName) e.fullName = '이름을 입력하세요.';
  if (!form.phone) e.phone = '연락처를 입력하세요.';
  else if (!PHONE_REGEX.test(form.phone)) e.phone = '형식이 올바르지 않습니다.';
  if (!form.email) e.email = '이메일을 입력하세요.';
  else if (!EMAIL_REGEX.test(form.email)) e.email = '올바른 이메일 형식이 아닙니다.';
  return e;
}

function validateUpdate(form: CreateUserPayload): FormErrors {
  const e: FormErrors = {};
  if (!form.department) e.department = '부서를 입력하세요.';
  if (!form.position) e.position = '직급을 입력하세요.';
  if (!form.fullName) e.fullName = '이름을 입력하세요.';
  if (!form.phone) e.phone = '연락처를 입력하세요.';
  else if (!PHONE_REGEX.test(form.phone)) e.phone = '형식이 올바르지 않습니다.';
  if (!form.email) e.email = '이메일을 입력하세요.';
  else if (!EMAIL_REGEX.test(form.email)) e.email = '올바른 이메일 형식이 아닙니다.';
  return e;
}

function Field({ label, required, error, className, children }: {
  label: string; required?: boolean; error?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="text-xs font-medium text-gray-700 mb-0.5 block">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
      <p className={`text-xs mt-0.5 h-4 leading-4 truncate ${error ? 'text-red-500' : 'invisible'}`}>
        {error ?? ' '}
      </p>
    </div>
  );
}

const inputCls = (error?: string) =>
  `w-full border ${error ? 'border-red-400 focus:border-red-500' : 'border-gray-300 focus:border-blue-500'} rounded-lg px-4 py-2.5 text-sm focus:outline-none`;

function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-lg mx-4 shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b sticky top-0 bg-white z-10">
          <h3 className="font-semibold text-gray-800">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DeleteAlert({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-sm mx-4 shadow-xl p-6">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-yellow-500 text-2xl">⚠️</span>
          <h3 className="font-semibold text-gray-800">회원 삭제</h3>
        </div>
        <p className="text-gray-600 text-sm mb-6 whitespace-pre-line">
          {'삭제한 데이터는 복구할 수 없습니다.\n정말로 삭제하시겠습니까?'}
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">취소</button>
          <button onClick={onConfirm}
            className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600">확인</button>
        </div>
      </div>
    </div>
  );
}

type ModalType = 'none' | 'create' | 'detail' | 'edit' | 'password' | 'delete';
type ApprovalFilter = 'all' | 'approved' | 'unapproved';
type DateType = 'created' | 'login';

export default function UsersPage() {
  const perm = usePermission('sys_users');

  const [users, setUsers] = useState<UserItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [search, setSearch] = useState('');
  const [dateType, setDateType] = useState<DateType>('created');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [approval, setApproval] = useState<ApprovalFilter>('all');

  const [modal, setModal] = useState<ModalType>('none');
  const [selected, setSelected] = useState<UserItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserItem | null>(null);
  const [alert, setAlert] = useState<string | null>(null);

  const [form, setForm] = useState<CreateUserPayload>({
    username: '', password: '', fullName: '', email: '',
    department: '', position: '', phone: '', isApproved: false,
  });
  const [showPw, setShowPw] = useState(false);
  const [formErrors, setFormErrors] = useState<FormErrors>({});

  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [showPwCurrent, setShowPwCurrent] = useState(false);
  const [showPwNext, setShowPwNext] = useState(false);
  const [showPwConfirm, setShowPwConfirm] = useState(false);
  const [pwError, setPwError] = useState('');

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await usersApi.getAll({
        search: search || undefined,
        dateType,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        approval,
      });
      setUsers(data.items);
      setTotal(data.total);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [search, dateType, startDate, endDate, approval]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const formatDate = (iso?: string) => {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('ko-KR', { hour12: false })
      .replace(/\. /g, '-').replace('.', '');
  };

  const openCreate = () => {
    setForm({ username: '', password: '', fullName: '', email: '',
      department: '', position: '', phone: '', isApproved: false });
    setFormErrors({});
    setShowPw(false);
    setModal('create');
  };

  const handleCreate = async () => {
    const errors = validateCreate(form);
    if (Object.keys(errors).length > 0) { setFormErrors(errors); return; }
    try {
      await usersApi.create(form);
      setModal('none');
      fetchUsers();
      setAlert('생성완료');
    } catch (err: any) {
      const msg = err.response?.data?.message ?? '';
      if (msg.includes('username') || msg.includes('already') || msg.includes('중복')) {
        setFormErrors({ username: '이미 사용 중인 아이디입니다.' });
      } else {
        setAlert('생성에 실패하였습니다.\n관리자에게 문의주세요.');
      }
    }
  };

  const openDetail = (user: UserItem) => {
    setSelected(user);
    setModal('detail');
  };

  const openEdit = () => {
    if (!selected) return;
    setForm({
      username: selected.username,
      password: '',
      fullName: selected.fullName,
      email: selected.email,
      department: selected.department ?? '',
      position: selected.position ?? '',
      phone: selected.phone ?? '',
      isApproved: selected.isApproved,
    });
    setFormErrors({});
    setModal('edit');
  };

  const handleUpdate = async () => {
    if (!selected) return;
    const errors = validateUpdate(form);
    if (Object.keys(errors).length > 0) { setFormErrors(errors); return; }
    const payload: UpdateUserPayload = {
      fullName: form.fullName,
      email: form.email,
      department: form.department,
      position: form.position,
      phone: form.phone,
      // approve 권한 있을 때만 승인 여부 변경
      ...(perm.approve && { isApproved: form.isApproved }),
    };
    try {
      const { data } = await usersApi.update(selected.id, payload);
      setSelected(data);
      setModal('detail');
      fetchUsers();
      setAlert('수정완료');
    } catch {
      setAlert('수정에 실패하였습니다.\n관리자에게 문의주세요.');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await usersApi.remove(deleteTarget.id);
      setModal('none');
      setDeleteTarget(null);
      setSelected(null);
      fetchUsers();
      setAlert('삭제완료');
    } catch {
      setModal('none');
      setAlert('삭제에 실패하였습니다.\n관리자에게 문의주세요.');
    }
  };

  const handleChangePassword = async () => {
    if (!selected) return;
    setPwError('');
    if (!pwForm.current) { setPwError('현재 비밀번호를 입력하세요.'); return; }
    if (!pwForm.next) { setPwError('새 비밀번호를 입력하세요.'); return; }
    if (pwForm.next !== pwForm.confirm) { setPwError('새 비밀번호가 일치하지 않습니다.'); return; }
    try {
      await usersApi.changePassword(selected.id, pwForm.current, pwForm.next);
      setPwForm({ current: '', next: '', confirm: '' });
      setModal('edit');
      setAlert('비밀번호가 변경되었습니다.');
    } catch (err: any) {
      const message = err.response?.data?.message ?? '';
      if (message.includes('일치하지')) {
        setAlert('현재 비밀번호가 일치하지 않습니다.');
      } else {
        setAlert('비밀번호 변경에 실패하였습니다.\n관리자에게 문의주세요.');
      }
    }
  };

  if (!perm.view) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-400 text-sm">접근 권한이 없습니다.</p>
      </div>
    );
  }

  return (
    <div className="p-8 bg-gray-50 min-h-full">
      <h1 className="text-xl font-bold text-gray-800 mb-6">회원 관리</h1>

      {/* 검색 */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 space-y-3">
        <div className="flex gap-2 items-center">
          <select
            value={dateType}
            onChange={e => setDateType(e.target.value as DateType)}
            className="border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none"
          >
            <option value="created">최초 등록일시</option>
            <option value="login">최근 접속일시</option>
          </select>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none flex-1" />
          <span className="text-gray-400">~</span>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none flex-1" />
        </div>
        <div className="relative">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && fetchUsers()}
            placeholder="검색어를 입력하세요"
            className="w-full border border-gray-300 rounded-lg px-4 py-2.5 pr-10 text-sm
                       focus:outline-none focus:border-blue-500" />
          <button onClick={fetchUsers}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">🔍</button>
        </div>
        <div className="flex gap-2">
          {(['all', 'approved', 'unapproved'] as ApprovalFilter[]).map(v => (
            <button key={v} onClick={() => setApproval(v)}
              className={`px-4 py-1.5 text-sm rounded-full border transition-colors
                ${approval === v
                  ? 'bg-[#2d4a7a] text-white border-[#2d4a7a]'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
              {v === 'all' ? '전체' : v === 'approved' ? '승인' : '미승인'}
            </button>
          ))}
        </div>
      </div>

      {/* 테이블 헤더 */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-gray-600">총 {total}건</p>
        {perm.create && (
          <button onClick={openCreate}
            className="px-4 py-2 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-700">
            생성 +
          </button>
        )}
      </div>

      {/* 테이블 */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#2d4a7a] text-white">
              <th className="px-4 py-3 text-center font-medium w-16">NO</th>
              <th className="px-4 py-3 text-center font-medium">승인 여부</th>
              <th className="px-4 py-3 text-center font-medium">아이디</th>
              <th className="px-4 py-3 text-center font-medium">사용자명</th>
              <th className="px-4 py-3 text-center font-medium">최초 등록일시</th>
              <th className="px-4 py-3 text-center font-medium">최초 등록자명</th>
              <th className="px-4 py-3 text-center font-medium">최근 접속일시</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="text-center py-10 text-gray-400">로딩 중...</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-10 text-gray-400">데이터가 없습니다.</td></tr>
            ) : (
              users.map((user, idx) => (
                <tr
                  key={user.id}
                  onClick={() => perm.detail && openDetail(user)}
                  className={`border-t border-gray-100 transition-colors
                    ${perm.detail ? 'hover:bg-blue-50 cursor-pointer' : ''}`}
                >
                  <td className="px-4 py-3 text-center text-gray-600">{total - idx}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium
                      ${user.isApproved ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                      {user.isApproved ? '승인' : '미승인'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center text-gray-800">{user.username}</td>
                  <td className="px-4 py-3 text-center text-gray-800">{user.fullName}</td>
                  <td className="px-4 py-3 text-center text-gray-600">{formatDate(user.createdAt)}</td>
                  <td className="px-4 py-3 text-center text-gray-600">{user.createdBy?.fullName ?? '-'}</td>
                  <td className="px-4 py-3 text-center text-gray-600">{formatDate(user.lastLoginAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── 생성 팝업 ── */}
      {modal === 'create' && (
        <Modal title="회원 생성" onClose={() => setModal('none')}>
          <div className="px-6 py-4 grid grid-cols-2 gap-x-4">
            <Field label="승인 여부" required className="col-span-2">
              <ApprovalToggle
                value={form.isApproved}
                onChange={perm.approve ? v => setForm(f => ({ ...f, isApproved: v })) : () => {}}
                disabled={!perm.approve}
              />
            </Field>
            <Field label="아이디" required error={formErrors.username}>
              <input value={form.username}
                onChange={e => { setForm(f => ({ ...f, username: e.target.value })); setFormErrors(fe => ({ ...fe, username: undefined })); }}
                placeholder="4~20자, 영문/숫자/_"
                className={inputCls(formErrors.username)} />
            </Field>
            <Field label="비밀번호" required error={formErrors.password}>
              <div className="relative">
                <input type={showPw ? 'text' : 'password'} value={form.password}
                  onChange={e => { setForm(f => ({ ...f, password: e.target.value })); setFormErrors(fe => ({ ...fe, password: undefined })); }}
                  placeholder="8자 이상" className={inputCls(formErrors.password) + ' pr-10'} />
                <button type="button" onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                  <EyeIcon show={showPw} />
                </button>
              </div>
            </Field>
            <Field label="부서" required error={formErrors.department}>
              <input value={form.department}
                onChange={e => { setForm(f => ({ ...f, department: e.target.value })); setFormErrors(fe => ({ ...fe, department: undefined })); }}
                placeholder="부서를 입력하세요" className={inputCls(formErrors.department)} />
            </Field>
            <Field label="직급" required error={formErrors.position}>
              <input value={form.position}
                onChange={e => { setForm(f => ({ ...f, position: e.target.value })); setFormErrors(fe => ({ ...fe, position: undefined })); }}
                placeholder="직급을 입력하세요" className={inputCls(formErrors.position)} />
            </Field>
            <Field label="이름" required error={formErrors.fullName}>
              <input value={form.fullName}
                onChange={e => { setForm(f => ({ ...f, fullName: e.target.value })); setFormErrors(fe => ({ ...fe, fullName: undefined })); }}
                placeholder="이름을 입력하세요" className={inputCls(formErrors.fullName)} />
            </Field>
            <Field label="연락처" required error={formErrors.phone}>
              <input value={form.phone}
                onChange={e => { const v = formatPhone(e.target.value); setForm(f => ({ ...f, phone: v })); setFormErrors(fe => ({ ...fe, phone: undefined })); }}
                placeholder="010-1234-5678" className={inputCls(formErrors.phone)} maxLength={13} />
            </Field>
            <Field label="이메일" required error={formErrors.email} className="col-span-2">
              <input value={form.email}
                onChange={e => { setForm(f => ({ ...f, email: e.target.value })); setFormErrors(fe => ({ ...fe, email: undefined })); }}
                placeholder="example@domain.com" className={inputCls(formErrors.email)} />
            </Field>
          </div>
          <div className="flex justify-end gap-2 px-6 py-3 border-t bg-gray-50 rounded-b-lg">
            <button onClick={() => setModal('none')}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100">취소</button>
            <button onClick={handleCreate}
              className="px-4 py-2 text-sm bg-[#2d4a7a] text-white rounded-lg hover:bg-[#1e3a6a]">생성</button>
          </div>
        </Modal>
      )}

      {/* ── 상세 팝업 ── */}
      {modal === 'detail' && selected && (
        <Modal title="회원 상세정보" onClose={() => setModal('none')}>
          <div className="px-6 py-4">
            <div className="flex justify-end gap-3 mb-4">
              {perm.update && (
                <button onClick={openEdit}
                  className="text-sm text-gray-600 hover:text-gray-800 flex items-center gap-1">
                  수정 ✏️
                </button>
              )}
              {perm.delete && (
                <button onClick={() => { setDeleteTarget(selected); setModal('delete'); }}
                  className="text-sm text-red-400 hover:text-red-600 flex items-center gap-1">
                  삭제 🗑
                </button>
              )}
            </div>
            <div className="space-y-0">
              {[
                {
                  label: '승인 여부', value: (
                    <div className="flex gap-2">
                      <span className={`px-3 py-1 rounded-full text-xs font-medium
                        ${selected.isApproved ? 'bg-[#2d4a7a] text-white' : 'bg-gray-100 text-gray-500'}`}>
                        승인
                      </span>
                      <span className={`px-3 py-1 rounded-full text-xs font-medium
                        ${!selected.isApproved ? 'bg-[#2d4a7a] text-white' : 'bg-gray-100 text-gray-500'}`}>
                        미승인
                      </span>
                    </div>
                  )
                },
                { label: '아이디',  value: selected.username },
                { label: '부서',    value: selected.department ?? '-' },
                { label: '직급',    value: selected.position ?? '-' },
                { label: '이름',    value: selected.fullName },
                { label: '연락처', value: selected.phone ?? '-' },
                { label: '이메일', value: selected.email },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center py-3 border-b border-gray-100 last:border-0">
                  <span className="text-sm text-gray-500 w-28 shrink-0">{label}</span>
                  <span className="text-sm text-gray-800">{value}</span>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* ── 수정 팝업 ── */}
      {modal === 'edit' && selected && (
        <Modal title="회원 수정" onClose={() => setModal('detail')}>
          <div className="px-6 py-4 grid grid-cols-2 gap-x-4">
            <Field label="승인 여부" required className="col-span-2">
              <ApprovalToggle
                value={form.isApproved}
                onChange={v => setForm(f => ({ ...f, isApproved: v }))}
                disabled={!perm.approve}
              />
            </Field>
            <Field label="아이디" required>
              <input value={form.username} disabled
                className={inputCls() + ' bg-gray-100 cursor-not-allowed'} />
            </Field>
            <Field label="비밀번호" required>
              <button
                onClick={() => { setPwForm({ current: '', next: '', confirm: '' }); setPwError(''); setModal('password'); }}
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm text-blue-600 hover:bg-blue-50 text-center"
              >
                비밀번호 변경
              </button>
            </Field>
            <Field label="부서" required error={formErrors.department}>
              <input value={form.department}
                onChange={e => { setForm(f => ({ ...f, department: e.target.value })); setFormErrors(fe => ({ ...fe, department: undefined })); }}
                placeholder="부서를 입력하세요" className={inputCls(formErrors.department)} />
            </Field>
            <Field label="직급" required error={formErrors.position}>
              <input value={form.position}
                onChange={e => { setForm(f => ({ ...f, position: e.target.value })); setFormErrors(fe => ({ ...fe, position: undefined })); }}
                placeholder="직급을 입력하세요" className={inputCls(formErrors.position)} />
            </Field>
            <Field label="이름" required error={formErrors.fullName}>
              <input value={form.fullName}
                onChange={e => { setForm(f => ({ ...f, fullName: e.target.value })); setFormErrors(fe => ({ ...fe, fullName: undefined })); }}
                placeholder="이름을 입력하세요" className={inputCls(formErrors.fullName)} />
            </Field>
            <Field label="연락처" required error={formErrors.phone}>
              <input value={form.phone}
                onChange={e => { const v = formatPhone(e.target.value); setForm(f => ({ ...f, phone: v })); setFormErrors(fe => ({ ...fe, phone: undefined })); }}
                placeholder="010-1234-5678" className={inputCls(formErrors.phone)} maxLength={13} />
            </Field>
            <Field label="이메일" required error={formErrors.email} className="col-span-2">
              <input value={form.email}
                onChange={e => { setForm(f => ({ ...f, email: e.target.value })); setFormErrors(fe => ({ ...fe, email: undefined })); }}
                placeholder="example@domain.com" className={inputCls(formErrors.email)} />
            </Field>
          </div>
          <div className="flex justify-end gap-2 px-6 py-3 border-t bg-gray-50 rounded-b-lg">
            <button onClick={() => setModal('detail')}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100">취소</button>
            <button onClick={handleUpdate}
              className="px-4 py-2 text-sm bg-[#2d4a7a] text-white rounded-lg hover:bg-[#1e3a6a]">저장</button>
          </div>
        </Modal>
      )}

      {/* ── 비밀번호 변경 팝업 ── */}
      {modal === 'password' && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-lg w-full max-w-md mx-4 shadow-xl">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h3 className="font-semibold text-gray-800">비밀번호 변경</h3>
              <button onClick={() => setModal('edit')} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <Field label="현재 비밀번호" required>
                <div className="relative">
                  <input type={showPwCurrent ? 'text' : 'password'} value={pwForm.current}
                    onChange={e => setPwForm(f => ({ ...f, current: e.target.value }))}
                    placeholder="현재 비밀번호를 입력하세요" className={inputCls + ' pr-10'} />
                  <button type="button" onClick={() => setShowPwCurrent(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                    <EyeIcon show={showPwCurrent} />
                  </button>
                </div>
              </Field>
              <Field label="새 비밀번호" required>
                <div className="relative">
                  <input type={showPwNext ? 'text' : 'password'} value={pwForm.next}
                    onChange={e => setPwForm(f => ({ ...f, next: e.target.value }))}
                    placeholder="새 비밀번호를 입력하세요" className={inputCls + ' pr-10'} />
                  <button type="button" onClick={() => setShowPwNext(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                    <EyeIcon show={showPwNext} />
                  </button>
                </div>
              </Field>
              <Field label="새 비밀번호 확인" required>
                <div className="relative">
                  <input type={showPwConfirm ? 'text' : 'password'} value={pwForm.confirm}
                    onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))}
                    placeholder="새 비밀번호를 한 번 더 입력하세요" className={inputCls + ' pr-10'} />
                  <button type="button" onClick={() => setShowPwConfirm(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                    <EyeIcon show={showPwConfirm} />
                  </button>
                </div>
              </Field>
              {pwError && <p className="text-red-500 text-xs">{pwError}</p>}
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50 rounded-b-lg">
              <button onClick={() => { setPwForm({ current: '', next: '', confirm: '' }); setModal('edit'); }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100">취소</button>
              <button onClick={handleChangePassword}
                className="px-4 py-2 text-sm bg-[#2d4a7a] text-white rounded-lg hover:bg-[#1e3a6a]">저장</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 삭제 Alert ── */}
      {modal === 'delete' && deleteTarget && (
        <DeleteAlert
          onCancel={() => { setDeleteTarget(null); setModal('detail'); }}
          onConfirm={handleDelete}
        />
      )}

      {/* ── 공통 Alert ── */}
      {alert && (
        <Alert message={alert} onClose={() => setAlert(null)} />
      )}
    </div>
  );
}