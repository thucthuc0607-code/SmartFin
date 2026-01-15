// Dán dòng này lên đầu file để chữa lỗi
(window as any).process = { env: {} };
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Chart as ChartJS, registerables } from 'chart.js';
import { Doughnut, Bar } from 'react-chartjs-2';
import { GoogleGenAI, Type } from '@google/genai';
import {
  collection,
  addDoc,
  onSnapshot,
  deleteDoc,
  doc,
  setDoc,
  query,
  orderBy,
} from 'firebase/firestore';
import { db } from './firebase';

// ==========================================
// 1. TYPES & ENUMS (Gộp từ types.ts)
// ==========================================

export enum TransactionType {
  EXPENSE = 'expense',
  INCOME = 'income',
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
}

export interface Transaction {
  id: string;
  amount: number;
  type: TransactionType;
  categoryId: string;
  note: string;
  date: string; // ISO string
  source?: 'cash' | 'bank' | 'momo';
  createdAt?: string; // Field cho Firestore sort
}

export interface BudgetConfig {
  cash: number;
  bank: number;
  eWallet: number;
}

export interface AnalysisData {
  mode: 'week' | 'month';
  currentTotal: number;
  previousTotal: number;
  topCategoryName: string;
  topCategoryDiffPercent: number;
  projectedTotal: number;
  budgetLimit: number;
  remainingDays: number;
}

export interface FinancialAdviceResponse {
  forecastText: string;
}

// ==========================================
// 2. CONSTANTS (Gộp từ constants.tsx)
// ==========================================

export const CATEGORIES: Category[] = [
  { id: '1', name: 'Ăn uống', icon: '🍟', color: 'bg-[#FF9500]' },
  { id: '2', name: 'Di chuyển', icon: '🚕', color: 'bg-[#5856D6]' },
  { id: '3', name: 'Mua sắm', icon: '🛒', color: 'bg-[#FF2D55]' },
  { id: '4', name: 'Hóa đơn', icon: '🧾', color: 'bg-[#AF52DE]' },
  { id: '5', name: 'Giải trí', icon: '🎮', color: 'bg-[#32ADE6]' },
  { id: '6', name: 'Lương', icon: '💵', color: 'bg-[#34C759]' },
  { id: '7', name: 'Khác', icon: '🌈', color: 'bg-[#8E8E93]' },
];

// ==========================================
// 3. SERVICES (Gộp từ services/geminiService.ts)
// ==========================================

const API_KEY = process.env.API_KEY || '';

class GeminiService {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: API_KEY });
  }

  async parseTransaction(text: string, categories: Category[]) {
    const categoryNames = categories.map((c) => c.name).join(', ');

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Phân tích câu sau thành dữ liệu giao dịch: "${text}". Các danh mục có sẵn: ${categoryNames}.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              amount: { type: Type.NUMBER, description: 'Số tiền giao dịch' },
              type: { type: Type.STRING, description: 'income hoặc expense' },
              categoryName: {
                type: Type.STRING,
                description: 'Tên danh mục phù hợp nhất từ danh sách đã cho',
              },
              note: { type: Type.STRING, description: 'Ghi chú ngắn gọn' },
            },
            required: ['amount', 'type', 'categoryName', 'note'],
          },
        },
      });
      return JSON.parse(response.text || '{}');
    } catch (e) {
      console.error('Failed to parse AI response', e);
      return null;
    }
  }

  async getFinancialAdvice(
    data: AnalysisData
  ): Promise<FinancialAdviceResponse | null> {
    const isWeek = data.mode === 'week';
    const periodName = isWeek ? 'Tuần' : 'Tháng';

    const prompt = `
      Đóng vai trợ lý SmartFin. Dựa trên dữ liệu:
      - Chế độ: ${periodName}
      - Đã chi: ${data.currentTotal} đ
      - Ngân sách: ${data.budgetLimit} đ
      - Top 1 chi tiêu: ${data.topCategoryName} (Thay đổi ${data.topCategoryDiffPercent}%)
      - Dự phóng cuối kỳ: ${data.projectedTotal} đ
      
      Hãy viết duy nhất 1 câu nhận xét/dự báo ngắn gọn, in nghiêng, có icon cảm xúc.
      Ví dụ: "Dự kiến cuối tuần bạn sẽ dư khoảng 500k, làm tốt lắm! 🎉" hoặc "Cảnh báo: Tốc độ chi tiêu hiện tại sẽ khiến bạn thâm hụt 200k vào cuối tháng ⚠️"
    `;

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              forecastText: { type: Type.STRING },
            },
            required: ['forecastText'],
          },
        },
      });
      return JSON.parse(response.text || '{}');
    } catch (e) {
      console.error('Failed to parse AI advice', e);
      return null;
    }
  }
}

const geminiService = new GeminiService();

// ==========================================
// 4. SUB-COMPONENTS
// ==========================================

// --- TransactionItem ---
const TransactionItem: React.FC<{
  transaction: Transaction;
  category?: Category;
  onDelete: (id: string) => void;
}> = ({ transaction, category, onDelete }) => {
  return (
    <div className="flex items-center justify-between py-4 group px-2 hover:bg-white/20 rounded-2xl transition-all duration-300">
      <div className="flex items-center space-x-4">
        <div
          className={`w-12 h-12 flex items-center justify-center rounded-2xl text-xl shadow-inner ${
            category?.color || 'bg-white/40'
          } border border-white/40`}
        >
          {category?.icon || '❓'}
        </div>
        <div>
          <h4 className="font-bold text-[17px] text-[#1C1C1E] leading-none mb-1">
            {category?.name || 'Khác'}
          </h4>
          <p className="text-[13px] text-[#3A3A3C] font-medium opacity-60 line-clamp-1">
            {transaction.note || 'Giao dịch không tên'}
          </p>
        </div>
      </div>
      <div className="flex flex-col items-end">
        <span
          className={`font-extrabold text-[17px] tracking-tight ${
            transaction.type === TransactionType.INCOME
              ? 'text-[#248A3D]'
              : 'text-[#1C1C1E]'
          }`}
        >
          {transaction.type === TransactionType.INCOME ? '+' : ''}
          {transaction.amount.toLocaleString()}đ
        </span>
        <button
          onClick={() => onDelete(transaction.id)}
          className="opacity-0 group-hover:opacity-100 transition-all text-[#FF3B30] text-[11px] font-bold uppercase tracking-wider mt-1"
        >
          Gỡ bỏ
        </button>
      </div>
    </div>
  );
};

// --- StatsOverview ---
const StatsOverview: React.FC<{
  transactions: Transaction[];
  budgetConfig: BudgetConfig;
  onOpenBudgetModal: () => void;
}> = ({ transactions, budgetConfig, onOpenBudgetModal }) => {
  const totalBudget =
    (budgetConfig.cash || 0) +
    (budgetConfig.bank || 0) +
    (budgetConfig.eWallet || 0);

  const formatShort = (num: number) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'tr';
    if (num >= 1000) return (num / 1000).toFixed(0) + 'k';
    return num.toLocaleString();
  };

  const todayStr = new Date().toISOString().split('T')[0];
  const todayExpense = transactions
    .filter(
      (t) => t.type === TransactionType.EXPENSE && t.date.startsWith(todayStr)
    )
    .reduce((sum, t) => sum + t.amount, 0);

  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();
  const currentMonthExpense = transactions
    .filter((t) => {
      const d = new Date(t.date);
      return (
        t.type === TransactionType.EXPENSE &&
        d.getMonth() === currentMonth &&
        d.getFullYear() === currentYear
      );
    })
    .reduce((sum, t) => sum + t.amount, 0);

  const remainingBalance = totalBudget - currentMonthExpense;
  const warningThreshold = totalBudget * 0.2;
  const isLowBalance =
    totalBudget > 0 &&
    remainingBalance > 0 &&
    remainingBalance < warningThreshold;
  const isOverBudget = remainingBalance < 0;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {/* Card 1: Hôm nay */}
      <div className="liquid-glass p-5 rounded-[24px] flex flex-col justify-between h-[110px] relative overflow-hidden group">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-8 h-8 rounded-full bg-[#FF3B30]/10 flex items-center justify-center text-[#FF3B30]">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </div>
          <span className="text-[12px] font-bold text-[#3A3A3C] opacity-60 uppercase tracking-wide">
            Hôm nay
          </span>
        </div>
        <p className="text-[22px] font-black text-[#FF3B30] tracking-tight">
          -{formatShort(todayExpense)}
        </p>
      </div>

      {/* Card 2: Ngân sách */}
      <div
        onClick={onOpenBudgetModal}
        className="liquid-glass p-5 rounded-[24px] flex flex-col justify-between h-[110px] cursor-pointer hover:bg-white/50 transition-all relative group"
      >
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-[#34C759]/10 flex items-center justify-center text-[#34C759]">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="6" />
                <circle cx="12" cy="12" r="2" />
              </svg>
            </div>
            <span className="text-[12px] font-bold text-[#3A3A3C] opacity-60 uppercase tracking-wide">
              Vốn tháng
            </span>
          </div>
          <div className="opacity-0 group-hover:opacity-100 transition-opacity text-[#34C759]">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </div>
        </div>
        <p className="text-[22px] font-black text-[#34C759] tracking-tight">
          {totalBudget > 0 ? formatShort(totalBudget) : 'Thiết lập'}
        </p>
      </div>

      {/* Card 3: Đã tiêu */}
      <div className="liquid-glass p-5 rounded-[24px] flex flex-col justify-between h-[110px]">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-8 h-8 rounded-full bg-black/5 flex items-center justify-center text-black/70">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          </div>
          <span className="text-[12px] font-bold text-[#3A3A3C] opacity-60 uppercase tracking-wide">
            Đã tiêu
          </span>
        </div>
        <p className="text-[22px] font-black text-[#1C1C1E] tracking-tight">
          -{formatShort(currentMonthExpense)}
        </p>
      </div>

      {/* Card 4: Còn lại */}
      <div
        className={`liquid-glass p-5 rounded-[24px] flex flex-col justify-between h-[110px] relative overflow-hidden transition-all duration-500 ${
          isLowBalance ? 'ring-2 ring-red-500/50 bg-red-50/10' : ''
        }`}
      >
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                isLowBalance || isOverBudget
                  ? 'bg-[#FF3B30]/10 text-[#FF3B30]'
                  : 'bg-[#007AFF]/10 text-[#007AFF]'
              }`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M19 5c-1.5 0-2.8 0.6-3.8 1.5l-2.5 2.5-3.2-3.2a1.5 1.5 0 0 0-2.1 0L4.9 8.3a1.5 1.5 0 0 0 0 2.1l5.3 5.3c0.6 0.6 1.5 0.6 2.1 0l6.7-6.7c1.5-1.5 2.5-3 2-4.5s-2.1-2.1-2-2.1z" />
              </svg>
            </div>
            <span className="text-[12px] font-bold text-[#3A3A3C] opacity-60 uppercase tracking-wide">
              Còn lại
            </span>
          </div>
        </div>
        <div>
          <p
            className={`text-[22px] font-black tracking-tight transition-colors ${
              isLowBalance || isOverBudget ? 'text-[#FF3B30]' : 'text-[#007AFF]'
            }`}
          >
            {formatShort(remainingBalance)}
          </p>
          {isLowBalance && (
            <div className="flex items-center gap-1 mt-1 animate-pulse">
              <span className="text-[10px] font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded uppercase tracking-wider">
                ⚠️ Sắp hết tiền!
              </span>
            </div>
          )}
          {isOverBudget && (
            <div className="flex items-center gap-1 mt-1">
              <span className="text-[10px] font-bold text-white bg-red-500 px-1.5 py-0.5 rounded uppercase tracking-wider">
                Đã lố ngân sách
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// --- ChartSection ---
ChartJS.register(...registerables);

const ChartSection: React.FC<{
  transactions: Transaction[];
  categories: Category[];
}> = ({ transactions, categories }) => {
  const categoryData = useMemo(() => {
    const expenses = transactions.filter(
      (t) => t.type === TransactionType.EXPENSE
    );
    const dataMap = new Map<string, number>();

    expenses.forEach((t) => {
      const current = dataMap.get(t.categoryId) || 0;
      dataMap.set(t.categoryId, current + t.amount);
    });

    const activeCategories = categories
      .filter((c) => (dataMap.get(c.id) || 0) > 0)
      .map((c) => ({
        label: c.name,
        value: dataMap.get(c.id) || 0,
        color: c.color.replace('bg-[', '').replace(']', ''),
      }));

    return {
      labels: activeCategories.map((c) => c.label),
      datasets: [
        {
          data: activeCategories.map((c) => c.value),
          backgroundColor: activeCategories.map((c) => c.color),
          borderColor: 'rgba(255, 255, 255, 0.5)',
          borderWidth: 1,
          hoverOffset: 4,
        },
      ],
    };
  }, [transactions, categories]);

  const weeklyData = useMemo(() => {
    const today = new Date();
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() - (6 - i));
      return d;
    });

    const expenses = transactions.filter(
      (t) => t.type === TransactionType.EXPENSE
    );

    const dataValues = last7Days.map((date) => {
      const dateStr = date.toISOString().split('T')[0];
      return expenses
        .filter((t) => t.date.startsWith(dateStr))
        .reduce((sum, t) => sum + t.amount, 0);
    });

    const labels = last7Days.map((d) => `${d.getDate()}/${d.getMonth() + 1}`);

    return {
      labels,
      datasets: [
        {
          label: 'Chi tiêu',
          data: dataValues,
          backgroundColor: 'rgba(0, 122, 255, 0.6)',
          borderRadius: 6,
          borderSkipped: false,
        },
      ],
    };
  }, [transactions]);

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          font: { family: "'Inter', sans-serif", size: 11 },
          color: '#3A3A3C',
          usePointStyle: true,
        },
      },
    },
  };

  const barOptions = {
    ...commonOptions,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          color: '#8E8E93',
          font: { family: "'Inter', sans-serif", size: 10 },
        },
      },
      y: {
        grid: { color: 'rgba(0,0,0,0.05)', borderDash: [4, 4] },
        border: { display: false },
        ticks: { display: false },
      },
    },
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
      <div className="liquid-glass p-6 rounded-[32px] flex flex-col">
        <h3 className="text-[18px] font-extrabold text-[#1C1C1E] mb-4 text-center">
          Phân bổ chi tiêu
        </h3>
        <div className="flex-1 min-h-[250px] relative">
          {categoryData.datasets[0].data.length > 0 ? (
            <Doughnut
              data={categoryData}
              options={{
                ...commonOptions,
                cutout: '65%',
                plugins: {
                  legend: {
                    position: 'bottom',
                    labels: { padding: 20, boxWidth: 10, usePointStyle: true },
                  },
                },
              }}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-slate-400 italic font-medium">
              Chưa có dữ liệu
            </div>
          )}
        </div>
      </div>
      <div className="liquid-glass p-6 rounded-[32px] flex flex-col">
        <h3 className="text-[18px] font-extrabold text-[#1C1C1E] mb-4 text-center">
          7 ngày gần nhất
        </h3>
        <div className="flex-1 min-h-[250px] relative">
          <Bar data={weeklyData} options={barOptions} />
        </div>
      </div>
    </div>
  );
};

// --- CalendarView ---
const CalendarView: React.FC<{ transactions: Transaction[] }> = ({
  transactions,
}) => {
  const today = new Date();
  const currentMonth = today.getMonth();
  const currentYear = today.getFullYear();
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const startDay = new Date(currentYear, currentMonth, 1).getDay();
  const adjustedStartDay = startDay === 0 ? 6 : startDay - 1;
  const daysArray = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const blanksArray = Array.from({ length: adjustedStartDay }, (_, i) => i);

  const getDailyExpense = (day: number) => {
    const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(
      2,
      '0'
    )}-${String(day).padStart(2, '0')}`;
    return transactions
      .filter(
        (t) => t.type === TransactionType.EXPENSE && t.date.startsWith(dateStr)
      )
      .reduce((sum, t) => sum + t.amount, 0);
  };

  const formatMoney = (amount: number) => {
    if (amount >= 1000000) return (amount / 1000000).toFixed(1) + 'tr';
    if (amount >= 1000) return (amount / 1000).toFixed(0) + 'k';
    return amount.toLocaleString();
  };

  const weekDays = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

  return (
    <div className="liquid-glass-dark p-5 rounded-[32px] border border-white/20">
      <div className="flex justify-between items-center mb-6">
        <h3 className="font-bold text-[18px] text-white">
          Tháng {currentMonth + 1}, {currentYear}
        </h3>
        <div className="text-[12px] font-bold text-white/60 bg-white/10 px-3 py-1 rounded-full border border-white/10">
          Hiện tại
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 mb-2">
        {weekDays.map((d) => (
          <div
            key={d}
            className="text-center text-[12px] font-bold text-white/40 py-2"
          >
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {blanksArray.map((i) => (
          <div key={`blank-${i}`} className="h-[65px]"></div>
        ))}
        {daysArray.map((day) => {
          const expense = getDailyExpense(day);
          const isToday = day === today.getDate();
          return (
            <div
              key={day}
              className={`h-[65px] rounded-[16px] flex flex-col items-center justify-start pt-2 transition-all border ${
                isToday
                  ? 'bg-white/20 border-white/40 shadow-inner'
                  : 'bg-white/5 border-white/5 hover:bg-white/10'
              }`}
            >
              <span
                className={`text-[13px] font-bold mb-0.5 ${
                  isToday ? 'text-white' : 'text-white/70'
                }`}
              >
                {day}
              </span>
              {expense > 0 && (
                <span className="text-[10px] font-bold text-[#FF9F0A] bg-[#FF9F0A]/20 px-1.5 py-0.5 rounded-md mt-1 border border-[#FF9F0A]/30">
                  {formatMoney(expense)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ==========================================
// 5. MAIN APP COMPONENT
// ==========================================

const App: React.FC = () => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [budgetConfig, setBudgetConfig] = useState<BudgetConfig>({
    cash: 0,
    bank: 0,
    eWallet: 0,
  });

  const [activeTab, setActiveTab] = useState<'home' | 'history' | 'ai'>('home');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isBudgetModalOpen, setIsBudgetModalOpen] = useState(false);
  const [tempBudgetConfig, setTempBudgetConfig] = useState<BudgetConfig>({
    cash: 0,
    bank: 0,
    eWallet: 0,
  });

  const [showWarningToast, setShowWarningToast] = useState(false);
  const [warningAmount, setWarningAmount] = useState(0);

  const [historyViewMode, setHistoryViewMode] = useState<'list' | 'calendar'>(
    'list'
  );

  // Filter States
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilterPopup, setActiveFilterPopup] = useState<
    'date' | 'category' | 'amount' | null
  >(null);
  const [filterDate, setFilterDate] = useState<{ start: string; end: string }>({
    start: '',
    end: '',
  });
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [filterAmount, setFilterAmount] = useState<{
    min: string;
    max: string;
  }>({ min: '', max: '' });

  // Input States
  const [inputMode, setInputMode] = useState<'manual' | 'ai'>('manual');
  const [smartInput, setSmartInput] = useState('');
  const [isParsing, setIsParsing] = useState(false);

  const [manualAmount, setManualAmount] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [manualCatId, setManualCatId] = useState(CATEGORIES[0].id);
  const [manualDate, setManualDate] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [manualType, setManualType] = useState<TransactionType>(
    TransactionType.EXPENSE
  );
  const [manualSource, setManualSource] = useState<'cash' | 'bank' | 'momo'>(
    'cash'
  );

  const [aiForecast, setAiForecast] = useState<string>('');
  const [isLoadingAdvice, setIsLoadingAdvice] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<'week' | 'month'>('month');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- FIREBASE LISTENERS ---
  // SỬA LẠI ĐOẠN NÀY: Lấy cả ID của giao dịch về
  useEffect(() => {
    const q = query(
      collection(db, 'transactions'),
      orderBy('createdAt', 'desc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map((doc) => ({
        id: doc.id, // <--- Dòng quan trọng nhất để xóa được
        ...doc.data(),
      }));
      setTransactions(items as any);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, 'settings', 'budget'), (doc) => {
      if (doc.exists()) {
        setBudgetConfig(doc.data() as BudgetConfig);
      } else {
        setBudgetConfig({ cash: 0, bank: 0, eWallet: 0 });
      }
    });
    return () => unsubscribe();
  }, []);

  // --- LOGIC ---
  useEffect(() => {
    setAiForecast('');
  }, [analysisMode]);

  const totalMonthlyBudget = useMemo(() => {
    return (
      (budgetConfig.cash || 0) +
      (budgetConfig.bank || 0) +
      (budgetConfig.eWallet || 0)
    );
  }, [budgetConfig]);

  useEffect(() => {
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    const currentMonthExpense = transactions
      .filter((t) => {
        const d = new Date(t.date);
        return (
          t.type === TransactionType.EXPENSE &&
          d.getMonth() === currentMonth &&
          d.getFullYear() === currentYear
        );
      })
      .reduce((sum, t) => sum + t.amount, 0);

    const remaining = totalMonthlyBudget - currentMonthExpense;
    if (
      totalMonthlyBudget > 0 &&
      remaining > 0 &&
      remaining < totalMonthlyBudget * 0.2
    ) {
      setWarningAmount(remaining);
      setShowWarningToast(true);
    } else {
      setShowWarningToast(false);
    }
  }, [transactions, totalMonthlyBudget]);

  const addTransaction = async (t: Omit<Transaction, 'id'>) => {
    try {
      await addDoc(collection(db, 'transactions'), {
        ...t,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('Error adding document: ', e);
      alert('Lỗi khi lưu giao dịch lên Cloud.');
    }
  };

  // Hàm xóa chuẩn
  const deleteTransaction = async (id: string) => {
    if (!id) {
      alert('Lỗi: Không tìm thấy ID!');
      return;
    }
    if (window.confirm('Bạn chắc chắn muốn xóa chứ?')) {
      try {
        await deleteDoc(doc(db, 'transactions', id));
      } catch (error) {
        console.error('Lỗi xóa:', error);
        alert('Không xóa được: ' + error);
      }
    }
  };

  const handleSaveBudgetConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await setDoc(doc(db, 'settings', 'budget'), tempBudgetConfig);
      setIsBudgetModalOpen(false);
    } catch (e) {
      console.error('Error updating budget: ', e);
      alert('Lỗi lưu ngân sách.');
    }
  };

  // --- HANDLERS ---
  const resetModal = () => {
    setSmartInput('');
    setManualAmount('');
    setManualNote('');
    setManualCatId(CATEGORIES[0].id);
    setManualDate(new Date().toISOString().split('T')[0]);
    setManualType(TransactionType.EXPENSE);
    setManualSource('cash');
    setIsModalOpen(false);
  };

  const openManualModal = (isRetroactive: boolean = false) => {
    setManualAmount('');
    setManualNote('');
    setManualCatId(CATEGORIES[0].id);
    setManualType(TransactionType.EXPENSE);
    setManualSource('cash');
    if (isRetroactive) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      setManualDate(yesterday.toISOString().split('T')[0]);
    } else {
      setManualDate(new Date().toISOString().split('T')[0]);
    }
    setInputMode('manual');
    setIsModalOpen(true);
  };

  const openBudgetModal = () => {
    setTempBudgetConfig({ ...budgetConfig });
    setIsBudgetModalOpen(true);
  };

  const handleExportCSV = () => {
    if (transactions.length === 0) {
      alert('Chưa có dữ liệu để xuất!');
      return;
    }
    const BOM = '\uFEFF';
    const headers = [
      'ID',
      'Ngày',
      'Số tiền',
      'Loại',
      'ID Danh mục',
      'Ghi chú',
      'Nguồn tiền',
    ];
    const csvRows = [headers.join(',')];
    transactions.forEach((t) => {
      const safeNote = `"${t.note.replace(/"/g, '""')}"`;
      const row = [
        t.id,
        t.date,
        t.amount,
        t.type,
        t.categoryId,
        safeNote,
        t.source || 'cash',
      ];
      csvRows.push(row.join(','));
    });
    const csvString = BOM + csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `SmartFin_Backup_${
      new Date().toISOString().split('T')[0]
    }.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const content = e.target?.result as string;
      if (!content) return;
      try {
        const lines = content.split('\n');
        if (lines.length < 2) {
          alert('File không hợp lệ.');
          return;
        }
        const newTransactions: Omit<Transaction, 'id'>[] = [];
        const parseLine = (line: string) => {
          const res = [];
          let current = '';
          let inQuote = false;
          for (let char of line) {
            if (char === '"') {
              inQuote = !inQuote;
            } else if (char === ',' && !inQuote) {
              res.push(current);
              current = '';
            } else {
              current += char;
            }
          }
          res.push(current);
          return res;
        };
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const cols = parseLine(line);
          if (cols.length >= 6) {
            const cleanNote = cols[5].replace(/^"|"$/g, '').replace(/""/g, '"');
            newTransactions.push({
              date: cols[1],
              amount: parseFloat(cols[2]) || 0,
              type: cols[3] as TransactionType,
              categoryId: cols[4],
              note: cleanNote,
              source: (cols[6] as 'cash' | 'bank' | 'momo') || 'cash',
            });
          }
        }
        if (newTransactions.length > 0) {
          if (
            window.confirm(
              `Tìm thấy ${newTransactions.length} giao dịch. Nhập vào Cloud?`
            )
          ) {
            let count = 0;
            for (const t of newTransactions) {
              await addDoc(collection(db, 'transactions'), {
                ...t,
                createdAt: new Date().toISOString(),
              });
              count++;
            }
            alert(`Đã nhập thành công ${count} giao dịch.`);
          }
        }
      } catch (err) {
        console.error(err);
        alert('Lỗi đọc file.');
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsText(file);
  };

  const handleSmartSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!smartInput.trim()) return;
    setIsParsing(true);
    const result = await geminiService.parseTransaction(smartInput, CATEGORIES);
    setIsParsing(false);
    if (result) {
      const category =
        CATEGORIES.find(
          (c) => c.name.toLowerCase() === result.categoryName.toLowerCase()
        ) || CATEGORIES[6];
      await addTransaction({
        amount: result.amount,
        type: result.type as TransactionType,
        categoryId: category.id,
        note: result.note,
        date: new Date().toISOString(),
        source: 'cash',
      });
      setSmartInput('');
      if (isModalOpen) resetModal();
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualAmount) return;
    await addTransaction({
      amount: parseFloat(manualAmount),
      type: manualType,
      categoryId: manualCatId,
      note: manualNote || 'Không có ghi chú',
      date: new Date(manualDate).toISOString(),
      source: manualSource,
    });
    resetModal();
  };

  const getTransactionsInRange = (startDate: Date, endDate: Date) => {
    return transactions.filter((t) => {
      if (t.type !== TransactionType.EXPENSE) return false;
      const d = new Date(t.date);
      const dTime = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate()
      ).getTime();
      const sTime = new Date(
        startDate.getFullYear(),
        startDate.getMonth(),
        startDate.getDate()
      ).getTime();
      const eTime = new Date(
        endDate.getFullYear(),
        endDate.getMonth(),
        endDate.getDate()
      ).getTime();
      return dTime >= sTime && dTime <= eTime;
    });
  };

  const dashboardData = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let currentStart = new Date(today);
    let currentEnd = new Date(today);
    let prevStart = new Date(today);
    let prevEnd = new Date(today);
    let budgetLimit = totalMonthlyBudget;
    let daysPassed = 1;
    let totalDays = 30;

    if (analysisMode === 'week') {
      const day = today.getDay();
      const diff = today.getDate() - day + (day === 0 ? -6 : 1);
      currentStart.setDate(diff);
      currentEnd.setDate(currentStart.getDate() + 6);
      prevStart = new Date(currentStart);
      prevStart.setDate(prevStart.getDate() - 7);
      prevEnd = new Date(prevStart);
      prevEnd.setDate(prevEnd.getDate() + 6);
      budgetLimit = totalMonthlyBudget / 4;
      daysPassed =
        (today.getTime() - currentStart.getTime()) / (1000 * 3600 * 24) + 1;
      if (daysPassed > 7) daysPassed = 7;
      if (daysPassed < 1) daysPassed = 1;
      totalDays = 7;
    } else {
      currentStart.setDate(1);
      currentEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      prevStart = new Date(currentStart);
      prevStart.setMonth(prevStart.getMonth() - 1);
      prevEnd = new Date(prevStart.getFullYear(), prevStart.getMonth() + 1, 0);
      budgetLimit = totalMonthlyBudget;
      daysPassed = today.getDate();
      totalDays = currentEnd.getDate();
    }

    const currentTrans = getTransactionsInRange(currentStart, new Date());
    const prevTrans = getTransactionsInRange(prevStart, prevEnd);
    const currentTotal = currentTrans.reduce((sum, t) => sum + t.amount, 0);
    const previousTotal = prevTrans.reduce((sum, t) => sum + t.amount, 0);

    const catMap = new Map<string, number>();
    currentTrans.forEach((t) => {
      const val = catMap.get(t.categoryId) || 0;
      catMap.set(t.categoryId, val + t.amount);
    });

    let topCatId = '';
    let topCatVal = 0;
    catMap.forEach((val, key) => {
      if (val > topCatVal) {
        topCatVal = val;
        topCatId = key;
      }
    });
    const topCatObj = CATEGORIES.find((c) => c.id === topCatId);
    const topCategoryName = topCatObj?.name || 'Chưa có';
    const topCategoryIcon = topCatObj?.icon || '📊';
    const prevCatVal = prevTrans
      .filter((t) => t.categoryId === topCatId)
      .reduce((sum, t) => sum + t.amount, 0);

    let diffPercent = 0;
    if (prevCatVal > 0) {
      diffPercent = Math.round(((topCatVal - prevCatVal) / prevCatVal) * 100);
    } else if (topCatVal > 0) {
      diffPercent = 100;
    }

    const projectedTotal = Math.round((currentTotal / daysPassed) * totalDays);
    const isSafe = projectedTotal <= budgetLimit;
    const statusLabel = isSafe ? 'Chi tiêu Tốt' : 'Cảnh báo';
    const highlightIsBad = diffPercent > 15;

    return {
      mode: analysisMode,
      currentTotal,
      previousTotal,
      topCategoryName,
      topCategoryIcon,
      topCategoryDiffPercent: diffPercent,
      projectedTotal,
      budgetLimit,
      isSafe,
      statusLabel,
      highlightIsBad,
      aiPayload: {
        mode: analysisMode,
        currentTotal,
        previousTotal,
        topCategoryName,
        topCategoryDiffPercent: diffPercent,
        projectedTotal,
        budgetLimit,
        remainingDays: totalDays - Math.floor(daysPassed),
      } as AnalysisData,
    };
  }, [transactions, analysisMode, totalMonthlyBudget]);

  useEffect(() => {
    if (activeTab === 'ai') {
      const fetchAdvice = async () => {
        setIsLoadingAdvice(true);
        const result = await geminiService.getFinancialAdvice(
          dashboardData.aiPayload
        );
        if (result && result.forecastText) {
          setAiForecast(result.forecastText);
        }
        setIsLoadingAdvice(false);
      };
      fetchAdvice();
    }
  }, [activeTab, analysisMode, dashboardData.aiPayload.currentTotal]);

  const filteredHistoryTransactions = useMemo(() => {
    return transactions.filter((t) => {
      if (
        searchTerm &&
        !t.note.toLowerCase().includes(searchTerm.toLowerCase())
      )
        return false;
      if (filterDate.start) {
        const d = new Date(t.date).getTime();
        const start = new Date(filterDate.start).getTime();
        if (d < start) return false;
      }
      if (filterDate.end) {
        const d = new Date(t.date);
        const end = new Date(filterDate.end);
        end.setHours(23, 59, 59, 999);
        if (d.getTime() > end.getTime()) return false;
      }
      if (
        filterCategories.length > 0 &&
        !filterCategories.includes(t.categoryId)
      )
        return false;
      if (filterAmount.min && t.amount < parseFloat(filterAmount.min))
        return false;
      if (filterAmount.max && t.amount > parseFloat(filterAmount.max))
        return false;
      return true;
    });
  }, [transactions, searchTerm, filterDate, filterCategories, filterAmount]);

  const toggleCategoryFilter = (catId: string) => {
    setFilterCategories((prev) =>
      prev.includes(catId)
        ? prev.filter((id) => id !== catId)
        : [...prev, catId]
    );
  };
  const calculateCurrentMonthTotal = () => {
    return filteredHistoryTransactions
      .filter((t) => t.type === TransactionType.EXPENSE)
      .reduce((sum, t) => sum + t.amount, 0);
  };

  return (
    <div className="max-w-xl mx-auto min-h-screen flex flex-col pb-32 no-scrollbar relative">
      <input
        type="file"
        accept=".csv"
        ref={fileInputRef}
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Warning Toast */}
      {showWarningToast && (
        <div className="fixed top-24 left-4 right-4 z-50 animate-in slide-in-from-top-4 fade-in duration-500">
          <div className="liquid-glass-dark p-4 rounded-2xl border-l-4 border-red-500 shadow-2xl flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-500/20 text-red-500 flex items-center justify-center animate-pulse">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div>
                <h4 className="text-white font-bold text-[14px]">
                  Cảnh báo tài chính
                </h4>
                <p className="text-white/80 text-[12px]">
                  Bạn chỉ còn{' '}
                  <span className="font-bold text-[#FF3B30]">
                    {warningAmount.toLocaleString()}đ
                  </span>{' '}
                  để chi tiêu!
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowWarningToast(false)}
              className="text-white/40 hover:text-white transition-colors"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="sticky top-0 z-40 px-6 pt-12 pb-4 tab-blur">
        <div className="flex items-center justify-between">
          <h1 className="large-title">SmartFin</h1>
          <button
            onClick={() => {
              setInputMode('manual');
              setIsModalOpen(true);
            }}
            className="w-12 h-12 rounded-2xl bg-[#007AFF] text-white shadow-xl shadow-blue-500/40 flex items-center justify-center active:scale-90 transition-all border border-white/30"
          >
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 px-6 pt-4 overflow-y-auto no-scrollbar">
        {activeTab === 'home' && (
          <div className="animate-in fade-in slide-in-from-bottom-6 duration-700">
            <StatsOverview
              transactions={transactions}
              budgetConfig={budgetConfig}
              onOpenBudgetModal={openBudgetModal}
            />
            <ChartSection transactions={transactions} categories={CATEGORIES} />
            <div className="liquid-glass p-6 rounded-[32px] mb-8">
              <div className="flex items-center justify-between mb-6">
                <h3 className="font-extrabold text-[20px] text-[#1C1C1E]">
                  Hoạt động
                </h3>
                <button
                  onClick={() => setActiveTab('history')}
                  className="text-[#007AFF] font-bold text-[14px]"
                >
                  Xem thêm
                </button>
              </div>
              <div className="space-y-1">
                {transactions.slice(0, 4).map((t) => (
                  <TransactionItem
                    key={t.id}
                    transaction={t}
                    onDelete={deleteTransaction}
                    category={CATEGORIES.find((c) => c.id === t.categoryId)}
                  />
                ))}
                {transactions.length === 0 && (
                  <p className="text-center py-6 text-slate-400 font-medium italic">
                    Bắt đầu bằng cách thêm chi tiêu
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="animate-in fade-in slide-in-from-right-10 duration-500">
            {/* 1. SMART INPUT */}
            <div className="liquid-glass-dark p-2 rounded-[24px] mb-4 flex gap-2 border border-white/20 shadow-lg relative z-40">
              <form
                onSubmit={handleSmartSubmit}
                className="flex-1 flex items-center bg-white/10 rounded-[20px] px-4 border border-white/5"
              >
                <input
                  type="text"
                  value={smartInput}
                  onChange={(e) => setSmartInput(e.target.value)}
                  placeholder={
                    isParsing ? 'Đang phân tích...' : 'Ví dụ: 35k ăn sáng...'
                  }
                  disabled={isParsing}
                  className="w-full bg-transparent border-none focus:ring-0 text-[15px] font-medium text-white placeholder:text-white/40"
                />
              </form>
              <button
                onClick={handleSmartSubmit}
                disabled={!smartInput.trim() || isParsing}
                className="bg-[#007AFF] text-white px-5 rounded-[20px] text-[13px] font-bold shadow-lg shadow-blue-500/20 active:scale-95 transition-all disabled:opacity-50"
              >
                {isParsing ? '...' : 'Thêm'}
              </button>
              <div className="w-[1px] h-6 bg-white/20 self-center mx-1"></div>
              <button
                onClick={() => openManualModal(true)}
                className="bg-white/10 hover:bg-white/20 text-white/80 px-4 rounded-[20px] text-[13px] font-bold active:scale-95 transition-all whitespace-nowrap"
              >
                Ghi bù
              </button>
            </div>

            {/* 2. SEARCH & FILTER */}
            <div className="mb-6 relative z-30">
              <div className="flex items-center gap-2 mb-2">
                <div className="flex-1 liquid-glass-dark h-12 rounded-[20px] flex items-center px-4 border border-white/20 focus-within:bg-white/20 transition-all">
                  <svg
                    className="text-white/50 mr-3"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Tìm theo ghi chú..."
                    className="bg-transparent border-none outline-none text-[14px] text-white placeholder:text-white/30 w-full font-medium"
                  />
                </div>
                <button
                  onClick={() =>
                    setActiveFilterPopup(
                      activeFilterPopup === 'date' ? null : 'date'
                    )
                  }
                  className={`h-12 w-12 rounded-[18px] flex items-center justify-center transition-all border ${
                    activeFilterPopup === 'date' ||
                    filterDate.start ||
                    filterDate.end
                      ? 'bg-[#007AFF] text-white border-[#007AFF]'
                      : 'liquid-glass-dark text-white/70 border-white/20'
                  }`}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                </button>
                <button
                  onClick={() =>
                    setActiveFilterPopup(
                      activeFilterPopup === 'category' ? null : 'category'
                    )
                  }
                  className={`h-12 w-12 rounded-[18px] flex items-center justify-center transition-all border ${
                    activeFilterPopup === 'category' ||
                    filterCategories.length > 0
                      ? 'bg-[#FF9F0A] text-white border-[#FF9F0A]'
                      : 'liquid-glass-dark text-white/70 border-white/20'
                  }`}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M4 9h16" />
                    <path d="M4 15h10" />
                    <path d="M10 3L8 21" />
                  </svg>
                </button>
                <button
                  onClick={() =>
                    setActiveFilterPopup(
                      activeFilterPopup === 'amount' ? null : 'amount'
                    )
                  }
                  className={`h-12 w-12 rounded-[18px] flex items-center justify-center transition-all border ${
                    activeFilterPopup === 'amount' ||
                    filterAmount.min ||
                    filterAmount.max
                      ? 'bg-[#34C759] text-white border-[#34C759]'
                      : 'liquid-glass-dark text-white/70 border-white/20'
                  }`}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 1v22" />
                    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                </button>
              </div>
              {activeFilterPopup && (
                <div className="absolute top-full left-0 right-0 mt-2 p-4 liquid-glass-dark rounded-[24px] border border-white/20 animate-in slide-in-from-top-2 z-40 shadow-2xl backdrop-blur-xl">
                  {activeFilterPopup === 'date' && (
                    <div className="space-y-3">
                      <h4 className="text-white font-bold text-[14px]">
                        Chọn khoảng thời gian
                      </h4>
                      <div className="flex gap-2">
                        <input
                          type="date"
                          value={filterDate.start}
                          onChange={(e) =>
                            setFilterDate({
                              ...filterDate,
                              start: e.target.value,
                            })
                          }
                          className="flex-1 bg-white/10 border border-white/10 rounded-xl p-2 text-white text-[13px]"
                        />
                        <span className="text-white/50 self-center">-</span>
                        <input
                          type="date"
                          value={filterDate.end}
                          onChange={(e) =>
                            setFilterDate({
                              ...filterDate,
                              end: e.target.value,
                            })
                          }
                          className="flex-1 bg-white/10 border border-white/10 rounded-xl p-2 text-white text-[13px]"
                        />
                      </div>
                      <button
                        onClick={() => setFilterDate({ start: '', end: '' })}
                        className="text-[12px] text-[#FF3B30] font-bold"
                      >
                        Xóa chọn
                      </button>
                    </div>
                  )}
                  {activeFilterPopup === 'category' && (
                    <div className="space-y-3">
                      <h4 className="text-white font-bold text-[14px]">
                        Lọc theo danh mục
                      </h4>
                      <div className="flex flex-wrap gap-2 max-h-[150px] overflow-y-auto no-scrollbar">
                        {CATEGORIES.map((cat) => (
                          <button
                            key={cat.id}
                            onClick={() => toggleCategoryFilter(cat.id)}
                            className={`px-3 py-1.5 rounded-full text-[12px] font-bold border transition-all flex items-center gap-1.5 ${
                              filterCategories.includes(cat.id)
                                ? 'bg-white text-black border-white'
                                : 'bg-white/5 text-white/60 border-white/10'
                            }`}
                          >
                            <span>{cat.icon}</span> {cat.name}
                          </button>
                        ))}
                      </div>
                      {filterCategories.length > 0 && (
                        <button
                          onClick={() => setFilterCategories([])}
                          className="text-[12px] text-[#FF3B30] font-bold"
                        >
                          Bỏ chọn tất cả
                        </button>
                      )}
                    </div>
                  )}
                  {activeFilterPopup === 'amount' && (
                    <div className="space-y-3">
                      <h4 className="text-white font-bold text-[14px]">
                        Lọc theo số tiền
                      </h4>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          placeholder="Tối thiểu"
                          value={filterAmount.min}
                          onChange={(e) =>
                            setFilterAmount({
                              ...filterAmount,
                              min: e.target.value,
                            })
                          }
                          className="flex-1 bg-white/10 border border-white/10 rounded-xl p-2 text-white text-[13px] placeholder:text-white/30"
                        />
                        <span className="text-white/50 self-center">-</span>
                        <input
                          type="number"
                          placeholder="Tối đa"
                          value={filterAmount.max}
                          onChange={(e) =>
                            setFilterAmount({
                              ...filterAmount,
                              max: e.target.value,
                            })
                          }
                          className="flex-1 bg-white/10 border border-white/10 rounded-xl p-2 text-white text-[13px] placeholder:text-white/30"
                        />
                      </div>
                      <button
                        onClick={() => setFilterAmount({ min: '', max: '' })}
                        className="text-[12px] text-[#FF3B30] font-bold"
                      >
                        Xóa chọn
                      </button>
                    </div>
                  )}
                  <div
                    onClick={() => setActiveFilterPopup(null)}
                    className="absolute top-2 right-4 text-white/30 p-2 cursor-pointer"
                  >
                    ✕
                  </div>
                </div>
              )}
            </div>

            {/* View Switcher & Tools */}
            <div className="flex items-center justify-between mb-4 px-1">
              <div className="flex bg-white/10 p-1 rounded-2xl border border-white/10">
                <button
                  onClick={() => setHistoryViewMode('list')}
                  className={`px-4 py-2 rounded-xl text-[13px] font-bold transition-all ${
                    historyViewMode === 'list'
                      ? 'bg-white/20 text-white shadow-sm'
                      : 'text-white/50'
                  }`}
                >
                  Danh sách
                </button>
                <button
                  onClick={() => setHistoryViewMode('calendar')}
                  className={`px-4 py-2 rounded-xl text-[13px] font-bold transition-all ${
                    historyViewMode === 'calendar'
                      ? 'bg-white/20 text-white shadow-sm'
                      : 'text-white/50'
                  }`}
                >
                  Lịch tháng
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleExportCSV}
                  className="w-9 h-9 flex items-center justify-center rounded-full bg-[#34C759]/20 text-[#34C759] border border-[#34C759]/30 active:scale-90 transition-all"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </button>
                <button
                  onClick={handleImportClick}
                  className="w-9 h-9 flex items-center justify-center rounded-full bg-[#007AFF]/20 text-[#007AFF] border border-[#007AFF]/30 active:scale-90 transition-all"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </button>
              </div>
            </div>

            {/* LIST OR CALENDAR */}
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              {historyViewMode === 'list' ? (
                <div className="liquid-glass-dark rounded-[32px] overflow-hidden border border-white/20 min-h-[300px]">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="text-white/50 text-[12px] uppercase tracking-wider border-b border-white/10">
                          <th className="p-4 font-semibold whitespace-nowrap">
                            Ngày
                          </th>
                          <th className="p-4 font-semibold min-w-[120px]">
                            Mô tả
                          </th>
                          <th className="p-4 font-semibold whitespace-nowrap">
                            Danh mục
                          </th>
                          <th className="p-4 font-semibold text-right whitespace-nowrap">
                            Số tiền
                          </th>
                          <th className="p-4"></th>
                        </tr>
                      </thead>
                      <tbody className="text-[14px] text-white">
                        {filteredHistoryTransactions.length > 0 ? (
                          filteredHistoryTransactions.map((t) => {
                            const cat = CATEGORIES.find(
                              (c) => c.id === t.categoryId
                            );
                            return (
                              <tr
                                key={t.id}
                                className="group hover:bg-white/5 transition-colors border-b border-white/5 last:border-0"
                              >
                                <td className="p-4 font-bold opacity-80 whitespace-nowrap">
                                  {new Date(t.date).toLocaleDateString(
                                    'vi-VN',
                                    {
                                      day: '2-digit',
                                      month: '2-digit',
                                      year: 'numeric',
                                    }
                                  )}
                                </td>
                                <td className="p-4">
                                  <div className="font-bold text-[15px]">
                                    {t.note}
                                  </div>
                                  <div className="text-[11px] opacity-50 italic mt-0.5 flex gap-1.5 items-center">
                                    {t.source === 'bank' && <span>💳</span>}
                                    {t.source === 'momo' && <span>🦄</span>}
                                    {(t.source === 'cash' || !t.source) && (
                                      <span>💵</span>
                                    )}
                                    <span>•</span>
                                    {new Date(t.date).toLocaleTimeString(
                                      'vi-VN',
                                      { hour: '2-digit', minute: '2-digit' }
                                    )}
                                  </div>
                                </td>
                                <td className="p-4">
                                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 border border-white/10 text-[12px] font-medium whitespace-nowrap">
                                    <span>{cat?.icon || '❓'}</span>
                                    <span>{cat?.name || 'Khác'}</span>
                                  </span>
                                </td>
                                <td className="p-4 text-right">
                                  <span
                                    className={`font-bold text-[15px] ${
                                      t.type === 'income'
                                        ? 'text-[#34C759]'
                                        : 'text-white'
                                    }`}
                                  >
                                    {t.type === 'income' ? '+' : ''}
                                    {Math.round(t.amount).toLocaleString()}đ
                                  </span>
                                </td>
                                <td className="p-4 text-center">
                                  <button
                                    onClick={() => deleteTransaction(t.id)}
                                    className="text-white/20 hover:text-[#FF3B30] transition-colors p-2"
                                    title="Xóa"
                                  >
                                    <svg
                                      width="18"
                                      height="18"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <polyline points="3 6 5 6 21 6" />
                                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                      <line x1="10" y1="11" x2="10" y2="17" />
                                      <line x1="14" y1="11" x2="14" y2="17" />
                                    </svg>
                                  </button>
                                </td>
                              </tr>
                            );
                          })
                        ) : (
                          <tr>
                            <td
                              colSpan={5}
                              className="py-12 text-center text-white/40 italic"
                            >
                              <div className="flex flex-col items-center">
                                <div className="text-4xl mb-3 opacity-50">
                                  👻
                                </div>
                                <p>Không tìm thấy giao dịch nào phù hợp.</p>
                                {(searchTerm ||
                                  filterDate.start ||
                                  filterCategories.length > 0 ||
                                  filterAmount.min) && (
                                  <button
                                    onClick={() => {
                                      setSearchTerm('');
                                      setFilterDate({ start: '', end: '' });
                                      setFilterCategories([]);
                                      setFilterAmount({ min: '', max: '' });
                                    }}
                                    className="mt-2 text-[#007AFF] text-[12px] font-bold"
                                  >
                                    Xóa bộ lọc
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                      {filteredHistoryTransactions.length > 0 && (
                        <tfoot className="bg-white/5 border-t border-white/10">
                          <tr>
                            <td
                              colSpan={3}
                              className="p-4 text-right font-bold text-white/60 uppercase text-[12px] tracking-wider"
                            >
                              Tổng cộng (Đang hiển thị)
                            </td>
                            <td className="p-4 text-right font-black text-[16px] text-[#FF9F0A]">
                              -
                              {Math.round(
                                calculateCurrentMonthTotal()
                              ).toLocaleString()}
                              đ
                            </td>
                            <td></td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>
              ) : (
                <CalendarView transactions={transactions} />
              )}
            </div>
          </div>
        )}

        {/* --- AI TAB --- */}
        {activeTab === 'ai' && (
          <div className="animate-in fade-in slide-in-from-left-10 duration-500">
            <div className="liquid-glass p-8 rounded-[32px] bg-gradient-to-br from-[#007AFF]/20 to-[#5856D6]/20 mb-6 relative overflow-hidden min-h-[400px]">
              <div className="absolute top-8 right-8 flex bg-white/20 rounded-full p-1 border border-white/20 z-20">
                <button
                  onClick={() => setAnalysisMode('week')}
                  className={`px-4 py-1.5 rounded-full text-[13px] font-bold transition-all ${
                    analysisMode === 'week'
                      ? 'bg-[#007AFF] text-white shadow-lg'
                      : 'bg-transparent text-white/60 hover:text-white'
                  }`}
                >
                  Tuần
                </button>
                <button
                  onClick={() => setAnalysisMode('month')}
                  className={`px-4 py-1.5 rounded-full text-[13px] font-bold transition-all ${
                    analysisMode === 'month'
                      ? 'bg-[#007AFF] text-white shadow-lg'
                      : 'bg-transparent text-white/60 hover:text-white'
                  }`}
                >
                  Tháng
                </button>
              </div>
              <div className="mb-6 z-10 relative">
                <div className="w-14 h-14 bg-white/40 rounded-3xl flex items-center justify-center text-2xl mb-4 border border-white/50 shadow-inner">
                  🤖
                </div>
                <h2 className="text-3xl font-black">Trợ lý Tài chính</h2>
                <p className="text-[#3A3A3C] font-semibold opacity-70 text-[15px]">
                  Phân tích {analysisMode === 'week' ? 'Tuần này' : 'Tháng này'}{' '}
                  của bạn.
                </p>
              </div>
              <div className="animate-in slide-in-from-bottom-4 duration-500">
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div
                    className={`rounded-[24px] p-4 flex flex-col items-center justify-center text-center border shadow-sm transition-colors duration-500 ${
                      dashboardData.isSafe
                        ? 'bg-[#34C759]/20 border-[#34C759]/30'
                        : 'bg-[#FF3B30]/20 border-[#FF3B30]/30'
                    }`}
                  >
                    <div
                      className={`text-3xl mb-2 ${
                        dashboardData.isSafe
                          ? 'text-[#34C759]'
                          : 'text-[#FF3B30]'
                      }`}
                    >
                      {dashboardData.isSafe ? '🛡️' : '⚠️'}
                    </div>
                    <div
                      className={`text-[13px] font-black uppercase tracking-wider ${
                        dashboardData.isSafe
                          ? 'text-[#248A3D]'
                          : 'text-[#C92A2A]'
                      }`}
                    >
                      {dashboardData.statusLabel}
                    </div>
                  </div>
                  <div className="bg-white/40 rounded-[24px] p-4 flex flex-col justify-center border border-white/40 shadow-sm relative overflow-hidden">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-2xl">
                        {dashboardData.topCategoryIcon}
                      </span>
                      <span className="font-bold text-[14px] leading-tight text-[#1C1C1E] line-clamp-1">
                        {dashboardData.topCategoryName}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span
                        className={`text-[20px] font-black ${
                          dashboardData.highlightIsBad
                            ? 'text-[#FF3B30]'
                            : 'text-[#1C1C1E]'
                        }`}
                      >
                        {dashboardData.topCategoryDiffPercent > 0 ? '⬆' : '⬇'}{' '}
                        {Math.abs(dashboardData.topCategoryDiffPercent)}%
                      </span>
                    </div>
                  </div>
                </div>
                <div className="bg-white/40 rounded-[24px] p-5 border border-white/40 shadow-sm mb-6 transition-all duration-500">
                  <div className="flex justify-between items-end mb-2">
                    <span className="text-[12px] font-bold text-[#3A3A3C]/60 uppercase tracking-wider">
                      Tiến độ ({analysisMode === 'week' ? 'Tuần' : 'Tháng'})
                    </span>
                    <div className="text-right">
                      <span className="font-black text-[15px] text-[#1C1C1E]">
                        {Math.round(dashboardData.currentTotal / 1000)}k
                      </span>
                      <span className="text-[13px] font-semibold text-[#3A3A3C]/40">
                        {' '}
                        / {Math.round(dashboardData.budgetLimit / 1000)}k
                      </span>
                    </div>
                  </div>
                  <div className="h-3 w-full bg-black/5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-1000 ${
                        dashboardData.currentTotal / dashboardData.budgetLimit >
                        0.8
                          ? 'bg-[#FF3B30]'
                          : dashboardData.currentTotal /
                              dashboardData.budgetLimit >
                            0.5
                          ? 'bg-[#FF9F0A]'
                          : 'bg-[#34C759]'
                      }`}
                      style={{
                        width: `${Math.min(
                          (dashboardData.currentTotal /
                            dashboardData.budgetLimit) *
                            100,
                          100
                        )}%`,
                      }}
                    ></div>
                  </div>
                </div>
                <div className="text-center px-4 min-h-[40px] flex items-center justify-center">
                  {isLoadingAdvice && !aiForecast ? (
                    <div className="flex gap-2 items-center text-[#1C1C1E]/50 text-[14px] font-medium animate-pulse">
                      <span>✨</span> Đang phân tích dữ liệu...
                    </div>
                  ) : (
                    <p className="text-[15px] font-medium text-[#1C1C1E]/70 italic leading-relaxed animate-in fade-in slide-in-from-bottom-2">
                      "{aiForecast || 'Chưa có đủ dữ liệu để dự báo.'}"
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <nav className="fixed bottom-8 left-6 right-6 h-20 liquid-glass-dark rounded-[30px] flex justify-around items-center px-4 z-50">
        <button
          onClick={() => setActiveTab('home')}
          className={`relative flex flex-col items-center justify-center w-16 h-16 rounded-2xl transition-all ${
            activeTab === 'home' ? 'text-[#007AFF]' : 'text-[#007AFF] '
          }`}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill={activeTab === 'home' ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          {activeTab === 'home' && (
            <span className="absolute -bottom-1 w-1.5 h-1.5 bg-[#007AFF] rounded-full"></span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`relative flex flex-col items-center justify-center w-16 h-16 rounded-2xl transition-all ${
            activeTab === 'history' ? 'text-[#007AFF]' : 'text-[#3A3A3C] '
          }`}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="M12 20V10M18 20V4M6 20v-4" />
          </svg>
          {activeTab === 'history' && (
            <span className="absolute -bottom-1 w-1.5 h-1.5 bg-[#007AFF] rounded-full"></span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('ai')}
          className={`relative flex flex-col items-center justify-center w-16 h-16 rounded-2xl transition-all ${
            activeTab === 'ai' ? 'text-[#007AFF]' : 'text-white '
          }`}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          {activeTab === 'ai' && (
            <span className="absolute -bottom-1 w-1.5 h-1.5 bg-[#007AFF] rounded-full"></span>
          )}
        </button>
      </nav>

      {/* MODAL & BUDGET MODAL (Giữ nguyên) */}
      {isModalOpen && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end animate-in fade-in duration-300">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-md"
            onClick={resetModal}
          />
          <div className="relative liquid-glass w-full rounded-t-[45px] p-6 pb-12 shadow-2xl animate-in slide-in-from-bottom-full duration-500 max-h-[90vh] overflow-y-auto no-scrollbar">
            <div className="w-12 h-1.5 bg-black/10 rounded-full mx-auto mb-6" />
            <div className="flex bg-black/5 p-1.5 rounded-[20px] mb-6 relative">
              <button
                onClick={() => setInputMode('manual')}
                className={`flex-1 py-3 rounded-[16px] text-[15px] font-bold transition-all z-10 ${
                  inputMode === 'manual'
                    ? 'bg-white shadow-sm text-black'
                    : 'text-black/50'
                }`}
              >
                Thủ công
              </button>
              <button
                onClick={() => setInputMode('ai')}
                className={`flex-1 py-3 rounded-[16px] text-[15px] font-bold transition-all z-10 ${
                  inputMode === 'ai'
                    ? 'bg-white shadow-sm text-black'
                    : 'text-black/50'
                }`}
              >
                AI Scan ✨
              </button>
            </div>
            {inputMode === 'ai' ? (
              <form onSubmit={handleSmartSubmit} className="space-y-6">
                <div className="text-center">
                  <h3 className="text-2xl font-black mb-1">
                    Ghi chép siêu tốc
                  </h3>
                  <p className="text-slate-500 font-bold text-[14px]">
                    Gemini đang lắng nghe bạn...
                  </p>
                </div>
                <div className="bg-white/40 p-6 rounded-[28px] border border-white/60 shadow-inner">
                  <textarea
                    autoFocus
                    value={smartInput}
                    onChange={(e) => setSmartInput(e.target.value)}
                    placeholder="Ví dụ: Cà phê sáng 35k..."
                    className="w-full bg-transparent border-none focus:ring-0 text-[20px] text-[#1C1C1E] font-bold placeholder:opacity-30 resize-none min-h-[120px]"
                  />
                </div>
                <div className="flex gap-4">
                  <button
                    type="button"
                    onClick={resetModal}
                    className="flex-1 bg-black/5 py-5 rounded-[24px] font-bold text-[#1C1C1E] active:scale-95 transition-all"
                  >
                    Đóng
                  </button>
                  <button
                    type="submit"
                    disabled={isParsing || !smartInput.trim()}
                    className="flex-[2] bg-[#007AFF] text-white py-5 rounded-[24px] font-black text-[18px] shadow-xl shadow-blue-500/30 active:scale-95 transition-all border border-white/30 disabled:opacity-50"
                  >
                    {isParsing ? 'Đang phân tích...' : 'Xác nhận'}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleManualSubmit} className="space-y-5">
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      setManualType(
                        manualType === TransactionType.EXPENSE
                          ? TransactionType.INCOME
                          : TransactionType.EXPENSE
                      )
                    }
                    className={`w-16 h-16 rounded-[20px] flex items-center justify-center text-2xl font-bold transition-all shadow-sm border border-white/40 ${
                      manualType === TransactionType.EXPENSE
                        ? 'bg-[#FF3B30]/10 text-[#FF3B30]'
                        : 'bg-[#34C759]/10 text-[#34C759]'
                    }`}
                  >
                    {manualType === TransactionType.EXPENSE ? '-' : '+'}
                  </button>
                  <div className="flex-1 bg-white/40 rounded-[20px] px-6 flex items-center border border-white/50 focus-within:bg-white/60 transition-all">
                    <input
                      type="number"
                      placeholder="0"
                      value={manualAmount}
                      onChange={(e) => setManualAmount(e.target.value)}
                      className="w-full bg-transparent border-none focus:ring-0 text-[32px] font-black text-[#1C1C1E] placeholder:text-black/10"
                      autoFocus
                    />
                    <span className="text-[20px] font-bold text-black/40">
                      đ
                    </span>
                  </div>
                </div>
                <div className="space-y-3">
                  <p className="text-[13px] font-bold text-black/40 uppercase tracking-wider ml-1">
                    Nguồn tiền
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setManualSource('cash')}
                      className={`flex-1 py-3 rounded-[18px] text-[14px] font-bold transition-all border ${
                        manualSource === 'cash'
                          ? 'bg-[#34C759] text-white border-[#34C759] shadow-lg shadow-green-500/30'
                          : 'bg-white/20 text-black/40 border-transparent hover:bg-white/30'
                      }`}
                    >
                      💵 Tiền mặt
                    </button>
                    <button
                      type="button"
                      onClick={() => setManualSource('bank')}
                      className={`flex-1 py-3 rounded-[18px] text-[14px] font-bold transition-all border ${
                        manualSource === 'bank'
                          ? 'bg-[#007AFF] text-white border-[#007AFF] shadow-lg shadow-blue-500/30'
                          : 'bg-white/20 text-black/40 border-transparent hover:bg-white/30'
                      }`}
                    >
                      💳 Ngân hàng
                    </button>
                    <button
                      type="button"
                      onClick={() => setManualSource('momo')}
                      className={`flex-1 py-3 rounded-[18px] text-[14px] font-bold transition-all border ${
                        manualSource === 'momo'
                          ? 'bg-[#FF2D55] text-white border-[#FF2D55] shadow-lg shadow-pink-500/30'
                          : 'bg-white/20 text-black/40 border-transparent hover:bg-white/30'
                      }`}
                    >
                      🦄 Ví Momo
                    </button>
                  </div>
                </div>
                <div className="space-y-3">
                  <p className="text-[13px] font-bold text-black/40 uppercase tracking-wider ml-1">
                    Danh mục
                  </p>
                  <div className="grid grid-cols-4 gap-3">
                    {CATEGORIES.map((cat) => (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => setManualCatId(cat.id)}
                        className={`flex flex-col items-center justify-center p-3 rounded-[20px] transition-all border ${
                          manualCatId === cat.id
                            ? 'bg-white shadow-md border-white scale-105'
                            : 'bg-white/20 border-transparent hover:bg-white/30'
                        }`}
                      >
                        <span className="text-2xl mb-1">{cat.icon}</span>
                        <span
                          className={`text-[10px] font-bold ${
                            manualCatId === cat.id
                              ? 'text-black'
                              : 'text-black/50'
                          }`}
                        >
                          {cat.name}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-3">
                  <p className="text-[13px] font-bold text-black/40 uppercase tracking-wider ml-1">
                    Thời gian
                  </p>
                  <div className="flex gap-3">
                    <div className="flex-1 bg-white/40 rounded-[20px] px-4 py-3 flex items-center border border-white/50">
                      <input
                        type="date"
                        value={manualDate}
                        onChange={(e) => setManualDate(e.target.value)}
                        className="w-full bg-transparent border-none focus:ring-0 text-[16px] font-bold text-[#1C1C1E]"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setManualDate(new Date().toISOString().split('T')[0])
                      }
                      className="bg-[#5856D6]/10 text-[#5856D6] px-5 rounded-[20px] font-bold text-[14px] active:scale-95 transition-all border border-[#5856D6]/20"
                    >
                      Hôm nay
                    </button>
                  </div>
                </div>
                <div className="bg-white/40 rounded-[24px] px-5 py-4 border border-white/50">
                  <input
                    type="text"
                    placeholder="Ghi chú (tùy chọn)"
                    value={manualNote}
                    onChange={(e) => setManualNote(e.target.value)}
                    className="w-full bg-transparent border-none focus:ring-0 text-[16px] font-medium text-[#1C1C1E] placeholder:text-black/30"
                  />
                </div>
                <div className="flex gap-4 pt-2">
                  <button
                    type="button"
                    onClick={resetModal}
                    className="flex-1 bg-black/5 py-4 rounded-[24px] font-bold text-[#1C1C1E] active:scale-95 transition-all"
                  >
                    Đóng
                  </button>
                  <button
                    type="submit"
                    className="flex-[2] bg-[#007AFF] text-white py-4 rounded-[24px] font-black text-[18px] shadow-xl shadow-blue-500/30 active:scale-95 transition-all border border-white/30"
                  >
                    Lưu
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {isBudgetModalOpen && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end animate-in fade-in duration-300">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-md"
            onClick={() => setIsBudgetModalOpen(false)}
          />
          <div className="relative liquid-glass w-full rounded-t-[45px] p-6 pb-12 shadow-2xl animate-in slide-in-from-bottom-full duration-500 max-h-[85vh] overflow-y-auto no-scrollbar">
            <div className="w-12 h-1.5 bg-white/20 rounded-full mx-auto mb-6" />
            <div className="text-center mb-8">
              <h3 className="text-2xl font-black text-[#1C1C1E]">
                Thiết lập Vốn đầu tháng
              </h3>
              <p className="text-[#3A3A3C] opacity-60 font-medium text-[14px]">
                Nhập số tiền bạn đang có ở từng nguồn.
              </p>
            </div>
            <form onSubmit={handleSaveBudgetConfig} className="space-y-6">
              <div className="bg-white/40 rounded-[24px] p-4 flex items-center border border-white/50">
                <div className="w-12 h-12 rounded-2xl bg-[#34C759]/10 flex items-center justify-center text-2xl mr-4 shadow-sm">
                  💵
                </div>
                <div className="flex-1">
                  <label className="block text-[12px] font-bold text-black/40 uppercase tracking-wider mb-1">
                    Tiền mặt
                  </label>
                  <input
                    type="number"
                    value={tempBudgetConfig.cash || ''}
                    onChange={(e) =>
                      setTempBudgetConfig({
                        ...tempBudgetConfig,
                        cash: parseFloat(e.target.value) || 0,
                      })
                    }
                    placeholder="0"
                    className="w-full bg-transparent border-none p-0 text-[20px] font-black text-[#1C1C1E] placeholder:text-black/10 focus:ring-0"
                  />
                </div>
              </div>
              <div className="bg-white/40 rounded-[24px] p-4 flex items-center border border-white/50">
                <div className="w-12 h-12 rounded-2xl bg-[#007AFF]/10 flex items-center justify-center text-2xl mr-4 shadow-sm">
                  💳
                </div>
                <div className="flex-1">
                  <label className="block text-[12px] font-bold text-black/40 uppercase tracking-wider mb-1">
                    Ngân hàng
                  </label>
                  <input
                    type="number"
                    value={tempBudgetConfig.bank || ''}
                    onChange={(e) =>
                      setTempBudgetConfig({
                        ...tempBudgetConfig,
                        bank: parseFloat(e.target.value) || 0,
                      })
                    }
                    placeholder="0"
                    className="w-full bg-transparent border-none p-0 text-[20px] font-black text-[#1C1C1E] placeholder:text-black/10 focus:ring-0"
                  />
                </div>
              </div>
              <div className="bg-white/40 rounded-[24px] p-4 flex items-center border border-white/50">
                <div className="w-12 h-12 rounded-2xl bg-[#FF2D55]/10 flex items-center justify-center text-2xl mr-4 shadow-sm">
                  📱
                </div>
                <div className="flex-1">
                  <label className="block text-[12px] font-bold text-black/40 uppercase tracking-wider mb-1">
                    Ví điện tử
                  </label>
                  <input
                    type="number"
                    value={tempBudgetConfig.eWallet || ''}
                    onChange={(e) =>
                      setTempBudgetConfig({
                        ...tempBudgetConfig,
                        eWallet: parseFloat(e.target.value) || 0,
                      })
                    }
                    placeholder="0"
                    className="w-full bg-transparent border-none p-0 text-[20px] font-black text-[#1C1C1E] placeholder:text-black/10 focus:ring-0"
                  />
                </div>
              </div>
              <button
                type="submit"
                className="w-full bg-[#1C1C1E] text-white py-5 rounded-[24px] font-black text-[18px] shadow-xl shadow-black/20 active:scale-95 transition-all mt-4"
              >
                Lưu thiết lập
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
