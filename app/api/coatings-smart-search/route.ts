import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const openaiApiKey = process.env.OPENAI_API_KEY!

const supabase = createClient(supabaseUrl, supabaseKey)
const openai = new OpenAI({ apiKey: openaiApiKey }) 

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

type ProductRecord = Record<string, any>

interface AIQueryPlan {
  intent: 'comparison' | 'lookup' | 'list' | 'count' | 'analytical'
  searchTerms: string[]
  filters?: {
    family?: string
    productType?: string
    productModel?: string
  }
  requiresMultipleProducts: boolean
  explanation: string
}

interface FilterCache {
  families: string[]
  productTypes: string[]
  productModels: string[]
  timestamp: number
  ttl: number
}

// 🎯 OPTIMIZED TOKEN LIMITS
const MAX_TOKENS = 30000
const MAX_INPUT_TOKENS = 20000
const MAX_DETAILED_PRODUCTS = 20
const MAX_SUMMARY_PRODUCTS = 100
const MAX_FIELD_LENGTH = 200

// 🎯 Semantic Search Configuration
const EMBEDDING_MODEL = 'text-embedding-3-small'
const SEMANTIC_SIMILARITY_THRESHOLD = 0.75
const SEMANTIC_SEARCH_LIMIT = 50

// 🎯 Cache for database schema
let schemaCache: string[] | null = null

// In-memory cache
let filterCache: FilterCache | null = null
const CACHE_TTL = 1000 * 60 * 60 * 24

// 🎯 Priority search fields (indexed fields for better performance)
const PRIORITY_SEARCH_FIELDS = [
  'Product_Type',
  'Product_Name',
  'Product_Model',
  'family',
  'sku'
]

// 🎯 Secondary search fields (searched only if priority fields fail)
const SECONDARY_SEARCH_FIELDS = [
  'Product_Description',
  'Application',
  'Notes'
]

// ============================================================================
// DATABASE UTILITIES
// ============================================================================

// Get actual database columns
async function getDatabaseColumns(): Promise<string[]> {
  if (schemaCache) {
    return schemaCache
  }

  try {
    const { data, error } = await supabase
      .from('coatings')
      .select('*')
      .limit(1)

    if (error || !data || data.length === 0) {
      console.error('❌ Failed to get database schema')
      return ['sku', 'family', 'Product_Name', 'Product_Type', 'Product_Model', 'Product_Description']
    }

    const columns = Object.keys(data[0])
    schemaCache = columns
    console.log(`✅ Database columns detected: ${columns.length} fields`)

    return columns
  } catch (error) {
    console.error('❌ Error getting database columns:', error)
    return ['sku', 'family', 'Product_Name', 'Product_Type', 'Product_Model', 'Product_Description']
  }
}

// Clean product data
function cleanProductData(product: ProductRecord): ProductRecord {
  const cleaned: ProductRecord = {}

  Object.entries(product).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      if (typeof value === 'string') {
        let cleanedValue = value
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<li>/gi, '• ')
          .replace(/<\/li>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&reg;/gi, '®')
          .replace(/&trade;/gi, '™')
          .replace(/&copy;/gi, '©')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .replace(/&rsquo;/gi, "'")
          .replace(/&lsquo;/gi, "'")
          .replace(/&rdquo;/gi, '"')
          .replace(/&ldquo;/gi, '"')
          .replace(/&deg;/gi, '°')
          .replace(/&plusmn;/gi, '±')
          .replace(/&times;/gi, '×')
          .replace(/&divide;/gi, '÷')
          .replace(/&ndash;/gi, '–')
          .replace(/&mdash;/gi, '—')
          .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
          .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\n{3,}/g, '\n\n')
          .trim()

        if (cleanedValue !== '') {
          cleaned[key] = cleanedValue
        }
      } else {
        cleaned[key] = value
      }
    }
  })

  return cleaned
}

// ============================================================================
// FILTER OPTIONS & CACHING
// ============================================================================

// Fetch ALL distinct values with pagination
async function fetchAllDistinctValues(columnName: string): Promise<string[]> {
  console.log(`  📊 Fetching all distinct values for: ${columnName}`)

  const allValues = new Set<string>()
  let page = 0
  const pageSize = 1000
  let hasMore = true

  while (hasMore) {
    const from = page * pageSize
    const to = from + pageSize - 1

    try {
      const { data, error } = await supabase
        .from('coatings')
        .select(columnName)
        .not(columnName, 'is', null)
        .neq(columnName, '')
        .order(columnName)
        .range(from, to)

      if (error || !data || data.length === 0) break

      data.forEach((row: any) => {
        const value = row[columnName]
        if (value && typeof value === 'string' && value.trim() !== '') {
          allValues.add(value.trim())
        }
      })

      if (data.length < pageSize) {
        hasMore = false
      } else {
        page++
      }

      if (page > 100) break

    } catch (err) {
      console.error(`  ❌ Exception fetching ${columnName}:`, err)
      break
    }
  }

  const sortedValues = Array.from(allValues).sort()
  console.log(`  ✅ ${columnName}: ${sortedValues.length} unique values`)

  return sortedValues
}

// Get filter options with caching
async function getFilterOptions(forceRefresh: boolean = false): Promise<any> {
  if (!forceRefresh && filterCache) {
    const now = Date.now()
    const cacheAge = now - filterCache.timestamp

    if (cacheAge < filterCache.ttl) {
      return {
        success: true,
        cached: true,
        filterOptions: {
          families: filterCache.families,
          productTypes: filterCache.productTypes,
          productModels: filterCache.productModels
        }
      }
    }
  }

  try {
    const [families, types, models] = await Promise.all([
      fetchAllDistinctValues('family'),
      fetchAllDistinctValues('Product_Type'),
      fetchAllDistinctValues('Product_Model')
    ])

    filterCache = {
      families,
      productTypes: types,
      productModels: models,
      timestamp: Date.now(),
      ttl: CACHE_TTL
    }

    return {
      success: true,
      cached: false,
      filterOptions: {
        families,
        productTypes: types,
        productModels: models
      }
    }
  } catch (error: any) {
    console.error('❌ Error fetching filter options:', error)

    if (filterCache) {
      return {
        success: true,
        cached: true,
        expired: true,
        filterOptions: {
          families: filterCache.families,
          productTypes: filterCache.productTypes,
          productModels: filterCache.productModels
        }
      }
    }

    return {
      success: false,
      error: 'Failed to fetch filter options',
      filterOptions: { families: [], productTypes: [], productModels: [] }
    }
  }
}

// ============================================================================
// SEMANTIC SEARCH (NEW!)
// ============================================================================

// Generate embedding for text
async function generateEmbedding(text: string): Promise<number[]> {
  try {
    console.log(`🧠 Generating embedding for: "${text.substring(0, 50)}..."`)
    
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    })
    
    console.log(`✅ Embedding generated (${response.data[0].embedding.length} dimensions)`)
    return response.data[0].embedding
  } catch (error) {
    console.error('❌ Embedding generation failed:', error)
    return []
  }
}

// 🎯 NEW: Semantic search using embeddings
async function executeSemanticSearch(
  queryText: string,
  appliedFilters: any,
  limit: number = SEMANTIC_SEARCH_LIMIT
): Promise<ProductRecord[]> {
  console.log(`🧠 Executing semantic search for: "${queryText}"`)

  try {
    // Generate embedding for user query
    const queryEmbedding = await generateEmbedding(queryText)

    if (queryEmbedding.length === 0) {
      console.log('⚠️ Semantic search failed, no embedding generated')
      return []
    }

    // Check if embedding column exists
    const columns = await getDatabaseColumns()
    if (!columns.includes('embedding')) {
      console.log('⚠️ Semantic search unavailable: embedding column not found')
      return []
    }

    // Use Supabase RPC function for vector similarity search
    const { data, error } = await supabase.rpc('match_coatings', {
      query_embedding: queryEmbedding,
      match_threshold: SEMANTIC_SIMILARITY_THRESHOLD,
      match_count: limit
    })

    if (error) {
      console.error('❌ Semantic search error:', error)
      console.error('❌ Error details:', JSON.stringify(error, null, 2))
      return []
    }

    if (!data || data.length === 0) {
      console.log('⚠️ Semantic search returned 0 results')
      console.log('   Possible reasons:')
      console.log('   1. No embeddings in database (all NULL)')
      console.log('   2. Similarity threshold too high (current: ' + SEMANTIC_SIMILARITY_THRESHOLD + ')')
      console.log('   3. Query embedding doesn\'t match any products closely')
      return []
    }

    console.log(`✅ Semantic search found ${data.length} products`)
    console.log(`   Top 3 similarities: ${data.slice(0, 3).map((d: any) => d.similarity?.toFixed(3)).join(', ')}`)
    
    return data || []

  } catch (error) {
    console.error('❌ Semantic search failed:', error)
    return []
  }
}

// ============================================================================
// AI QUERY PLANNING
// ============================================================================

async function planQuery(userQuery: string, appliedFilters: any): Promise<AIQueryPlan> {
  console.log(`🤖 AI analyzing query: "${userQuery}"`)

  const systemPrompt = `Analyze user query and return JSON:
{
  "intent": "comparison|lookup|list|count|analytical",
  "searchTerms": ["term1", "term2"],
  "filters": {"productType": "optional", "productModel": "optional", "family": "optional"},
  "requiresMultipleProducts": true/false,
  "explanation": "brief explanation"
}

Intent types:
- comparison: Compare 2+ products
- lookup: Info about specific product(s)
- list: All products matching criteria
- count: How many products
- analytical: Recommendations/advice

IMPORTANT: For SKU comparisons, keep SKUs as complete search terms (e.g., ["8211FCLEARCAX22K", "8211FCLEARCAY22K"])`

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Query: "${userQuery}"\nFilters: ${JSON.stringify(appliedFilters)}` }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })

    const plan = JSON.parse(completion.choices[0].message.content || '{}') as AIQueryPlan
    console.log(`✅ AI Query Plan:`, plan)
    return plan
  } catch (error) {
    console.error('❌ AI planning failed:', error)
    return {
      intent: 'lookup',
      searchTerms: [userQuery],
      requiresMultipleProducts: false,
      explanation: 'Fallback'
    }
  }
}

// ============================================================================
// SMART SEARCH LOGIC
// ============================================================================

// 🎯 SMART: Detect if query is asking about product categories
function isCategoryQuery(query: string): { isCategory: boolean; categoryTerm?: string } {
  const lowerQuery = query.toLowerCase().trim()

  // 🎯 Category keywords (these indicate a category search)
  const categoryKeywords = [
    'primer', 'epoxy', 'polyurethane', 'urethane', 'topcoat', 'basecoat',
    'sealer', 'sealant', 'thinner', 'reducer', 'cleaner', 'stripper',
    'converter', 'activator', 'catalyst', 'acrylic', 'wash'
  ]

  // Check if query is asking "what/which products are [category]"
  const categoryPatterns = [
    /(?:what|which|show|list|find|get)\s+(?:products?|items?)\s+(?:are|is)\s+([\w\s]+)/i,
    /(?:show|list|find|get)\s+(?:me\s+)?(?:all\s+)?([\w\s]+?)\s*(?:products?)?$/i,
    /^([\w\s]+?)\s*(?:products?)?$/i
  ]

  for (const pattern of categoryPatterns) {
    const match = lowerQuery.match(pattern)
    if (match) {
      const term = match[1]?.toLowerCase().trim()

      // Check if the term contains any category keyword
      if (term) {
        for (const keyword of categoryKeywords) {
          if (term.includes(keyword) || keyword.includes(term)) {
            console.log(`🎯 Category keyword detected: "${keyword}" in query term "${term}"`)
            return { isCategory: true, categoryTerm: term }
          }
        }
      }
    }
  }

  return { isCategory: false }
}

// 🎯 NEW: Detect if search terms are SKUs
function detectSKUs(searchTerms: string[]): string[] {
  const skuPattern = /^[A-Z0-9]{8,}$/i // Alphanumeric, 8+ chars, no spaces
  
  return searchTerms.filter(term => {
    const cleanTerm = term.trim().replace(/[^A-Z0-9]/gi, '')
    return skuPattern.test(cleanTerm)
  })
}

// 🎯 IMPROVED: Smart search with multiple strategies
async function executeSmartSearch(plan: AIQueryPlan, appliedFilters: any): Promise<ProductRecord[]> {
  console.log(`⚡ Executing smart search for: ${plan.searchTerms.join(', ')}`)

  const allResults: ProductRecord[] = []
  const seenIds = new Set<string>()

  // Get available columns
  const allColumns = await getDatabaseColumns()

  // Filter priority fields to only existing ones
  const availablePriorityFields = PRIORITY_SEARCH_FIELDS.filter(f => allColumns.includes(f))
  const availableSecondaryFields = SECONDARY_SEARCH_FIELDS.filter(f => allColumns.includes(f))

  console.log(`🔍 Priority fields: ${availablePriorityFields.join(', ')}`)
  console.log(`🔍 Secondary fields: ${availableSecondaryFields.join(', ')}`)

  // Parse search terms
  const searchPhrase = plan.searchTerms.join(' ')
  const searchWords = searchPhrase.toLowerCase().split(/\s+/).filter(w => w.length > 2)

  console.log(`🔍 Search phrase: "${searchPhrase}"`)
  console.log(`🔍 Search words: ${searchWords.join(', ')}`)

  // ============================================================================
  // 🎯 STRATEGY 0: EXACT SKU MATCH (HIGHEST PRIORITY)
  // ============================================================================
  
  console.log(`\n🎯 STRATEGY 0: Exact SKU Match...`)
  const potentialSKUs = detectSKUs(plan.searchTerms)
  
  if (potentialSKUs.length > 0) {
    console.log(`  🏷️ Detected ${potentialSKUs.length} potential SKU(s): ${potentialSKUs.join(', ')}`)
    
    for (const skuTerm of potentialSKUs) {
      const cleanSKU = skuTerm.trim().toUpperCase()
      
      try {
        let query = supabase.from('coatings').select('*')

        // Apply filters
        if (appliedFilters.family) query = query.eq('family', appliedFilters.family)
        if (appliedFilters.productType) query = query.eq('Product_Type', appliedFilters.productType)
        if (appliedFilters.productModel) query = query.eq('Product_Model', appliedFilters.productModel)

        // Try exact match (case-insensitive)
        query = query.or(`sku.ilike.${cleanSKU},Product_Model.ilike.${cleanSKU},Product_Name.ilike.${cleanSKU}`)

        const { data, error } = await query.limit(10)

        if (data && data.length > 0) {
          console.log(`  ✅ Found ${data.length} exact SKU match(es) for "${cleanSKU}"`)
          data.forEach((item: any) => {
            const id = item.id || item.sku || JSON.stringify(item)
            if (!seenIds.has(id)) {
              seenIds.add(id)
              allResults.push(item)
            }
          })
        } else {
          console.log(`  ⚠️ No exact match for SKU "${cleanSKU}"`)
        }
      } catch (err) {
        console.error(`  ❌ SKU search failed for "${cleanSKU}":`, err)
      }
    }

    // If we found exact SKU matches, return immediately
    if (allResults.length > 0) {
      console.log(`✅ Returning ${allResults.length} exact SKU match(es)`)
      return allResults
    }
  }

  // ============================================================================
  // 🎯 STRATEGY 1: SEMANTIC SEARCH (NEW!)
  // ============================================================================
  
  console.log(`\n🧠 STRATEGY 1: Semantic Search...`)
  
  // Check if embeddings are available
  if (allColumns.includes('embedding')) {
    try {
      const semanticResults = await executeSemanticSearch(searchPhrase, appliedFilters, 100)

      if (semanticResults.length > 0) {
        console.log(`✅ Semantic search found ${semanticResults.length} products`)
        
        semanticResults.forEach((item: any) => {
          const id = item.id || item.sku || JSON.stringify(item)
          if (!seenIds.has(id)) {
            seenIds.add(id)
            allResults.push(item)
          }
        })

        // If semantic search found good results, return them
        if (allResults.length >= 5) {
          console.log(`✅ Returning ${allResults.length} semantic search results`)
          return allResults
        }
      }
    } catch (err) {
      console.error(`❌ Semantic search failed:`, err)
    }
  } else {
    console.log(`⚠️ Semantic search unavailable (no embedding column)`)
  }

  // ============================================================================
  // 🎯 STRATEGY 2: CATEGORY-SPECIFIC SEARCH
  // ============================================================================
  
  const categoryCheck = isCategoryQuery(searchPhrase)

  if (categoryCheck.isCategory && categoryCheck.categoryTerm) {
    console.log(`\n🎯 STRATEGY 2: Category Search for "${categoryCheck.categoryTerm}"`)

    try {
      let query = supabase.from('coatings').select('*')

      // Apply filters
      if (appliedFilters.family) query = query.eq('family', appliedFilters.family)
      if (appliedFilters.productType) query = query.eq('Product_Type', appliedFilters.productType)
      if (appliedFilters.productModel) query = query.eq('Product_Model', appliedFilters.productModel)

      // Build OR conditions for Product_Type and Product_Model
      const orConditions: string[] = []

      searchWords.forEach(word => {
        if (allColumns.includes('Product_Type')) {
          orConditions.push(`Product_Type.ilike.%${word}%`)
        }
        if (allColumns.includes('Product_Model')) {
          orConditions.push(`Product_Model.ilike.%${word}%`)
        }
      })

      if (orConditions.length > 0) {
        query = query.or(orConditions.join(','))
      }

      const { data, error } = await query.limit(1000)

      console.log(`📊 Category search: ${data?.length || 0} products`)

      if (data && data.length > 0) {
        // Score and filter results
        const scoredResults = data.map(item => {
          const productType = (item.Product_Type || '').toLowerCase()
          const productModel = (item.Product_Model || '').toLowerCase()

          let score = 0

          // Exact phrase match in Product_Type (highest priority)
          if (productType.includes(searchPhrase.toLowerCase())) {
            score += 100
          }

          // Exact phrase match in Product_Model
          if (productModel.includes(searchPhrase.toLowerCase())) {
            score += 80
          }

          // Individual word matches in Product_Type
          searchWords.forEach(word => {
            if (productType.includes(word)) score += 10
          })

          // Individual word matches in Product_Model
          searchWords.forEach(word => {
            if (productModel.includes(word)) score += 5
          })

          return { item, score }
        })

        // Filter: Keep only items with score > 0
        const filtered = scoredResults
          .filter(r => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .map(r => r.item)

        console.log(`✅ Category search found ${filtered.length} relevant products`)

        if (filtered.length > 0) {
          filtered.forEach((item: any) => {
            const id = item.id || item.sku || JSON.stringify(item)
            if (!seenIds.has(id)) {
              seenIds.add(id)
              allResults.push(item)
            }
          })

          return allResults
        }
      }
    } catch (err) {
      console.error(`❌ Category search failed:`, err)
    }
  }

  // ============================================================================
  // 🎯 STRATEGY 3: COMPREHENSIVE KEYWORD SEARCH (FALLBACK)
  // ============================================================================
  
  console.log(`\n📊 STRATEGY 3: Comprehensive Keyword Search...`)

  try {
    let query = supabase.from('coatings').select('*')

    // Apply filters
    if (appliedFilters.family) query = query.eq('family', appliedFilters.family)
    if (appliedFilters.productType) query = query.eq('Product_Type', appliedFilters.productType)
    if (appliedFilters.productModel) query = query.eq('Product_Model', appliedFilters.productModel)

    // Build OR conditions across ALL searchable fields
    const orConditions: string[] = []

    searchWords.forEach(word => {
      // Priority fields
      if (allColumns.includes('Product_Type')) orConditions.push(`Product_Type.ilike.%${word}%`)
      if (allColumns.includes('Product_Model')) orConditions.push(`Product_Model.ilike.%${word}%`)
      if (allColumns.includes('Product_Name')) orConditions.push(`Product_Name.ilike.%${word}%`)
      if (allColumns.includes('family')) orConditions.push(`family.ilike.%${word}%`)
      if (allColumns.includes('sku')) orConditions.push(`sku.ilike.%${word}%`)

      // Secondary fields
      if (allColumns.includes('Product_Description')) orConditions.push(`Product_Description.ilike.%${word}%`)
      if (allColumns.includes('Application')) orConditions.push(`Application.ilike.%${word}%`)
      if (allColumns.includes('Notes')) orConditions.push(`Notes.ilike.%${word}%`)
    })

    if (orConditions.length > 0) {
      query = query.or(orConditions.join(','))
    }

    const { data, error } = await query.limit(1000)

    console.log(`📊 Comprehensive search: ${data?.length || 0} products`)

    if (data && data.length > 0) {
      // 🎯 SCORE EACH RESULT
      const scoredResults = data.map(item => {
        const sku = (item.sku || '').toLowerCase()
        const productType = (item.Product_Type || '').toLowerCase()
        const productModel = (item.Product_Model || '').toLowerCase()
        const productName = (item.Product_Name || '').toLowerCase()
        const description = (item.Product_Description || '').toLowerCase()
        const application = (item.Application || '').toLowerCase()
        const notes = (item.Notes || '').toLowerCase()

        let score = 0

        // EXACT PHRASE MATCHES (highest priority)
        if (sku === searchPhrase.toLowerCase()) score += 2000
        if (productType === searchPhrase.toLowerCase()) score += 1000
        if (productModel === searchPhrase.toLowerCase()) score += 1000
        if (sku.includes(searchPhrase.toLowerCase())) score += 1500
        if (productType.includes(searchPhrase.toLowerCase())) score += 500
        if (productModel.includes(searchPhrase.toLowerCase())) score += 500
        if (productName.includes(searchPhrase.toLowerCase())) score += 300

        // INDIVIDUAL WORD MATCHES IN PRIORITY FIELDS
        searchWords.forEach(word => {
          if (sku.includes(word)) score += 100
          if (productType.includes(word)) score += 50
          if (productModel.includes(word)) score += 50
          if (productName.includes(word)) score += 30
        })

        // INDIVIDUAL WORD MATCHES IN SECONDARY FIELDS
        searchWords.forEach(word => {
          if (description.includes(word)) score += 5
          if (application.includes(word)) score += 5
          if (notes.includes(word)) score += 3
        })

        // BONUS: Multiple word matches
        const matchedWords = searchWords.filter(word => {
          const allText = `${sku} ${productType} ${productModel} ${productName} ${description} ${application}`.toLowerCase()
          return allText.includes(word)
        })

        if (matchedWords.length >= 2) {
          score += matchedWords.length * 20
        }

        return { item, score, matchedWords: matchedWords.length }
      })

      // FILTER: Keep only relevant results
      const minWordsRequired = searchWords.length > 1 ? Math.min(2, searchWords.length) : 1
      const minScoreRequired = searchWords.length > 1 ? 50 : 30

      const filtered = scoredResults
        .filter(r => r.matchedWords >= minWordsRequired || r.score >= minScoreRequired)
        .sort((a, b) => b.score - a.score)
        .map(r => r.item)

      console.log(`✅ Found ${filtered.length} relevant products (filtered from ${data.length})`)
      console.log(`📊 Top 5 scores:`, scoredResults.slice(0, 5).map(r => `${r.score} pts`))

      if (filtered.length > 0) {
        filtered.forEach((item: any) => {
          const id = item.id || item.sku || JSON.stringify(item)
          if (!seenIds.has(id)) {
            seenIds.add(id)
            allResults.push(item)
          }
        })

        return allResults
      }
    }
  } catch (err) {
    console.error(`❌ Strategy 3 failed:`, err)
  }

  console.log(`⚠️ No results found`)
  return []
}

// ============================================================================
// FORMATTING UTILITIES
// ============================================================================

// Create comprehensive product list table
function createProductListTable(products: ProductRecord[]): string {
  const headers = '| # | Family | SKU | Product Name | Type | Model |'
  const separator = '|---|--------|-----|--------------|------|-------|'

  const rows = products.map((p, i) => {
    const family = (p.family || 'N/A').substring(0, 20)
    const sku = (p.sku || 'N/A').substring(0, 15)
    const name = (p.Product_Name || 'N/A').substring(0, 40)
    const type = (p.Product_Type || 'N/A').substring(0, 15)
    const model = (p.Product_Model || 'N/A').substring(0, 15)

    return `| ${i + 1} | ${family} | ${sku} | ${name} | ${type} | ${model} |`
  })

  return [headers, separator, ...rows].join('\n')
}

// Group products by family and show representative samples
function createFamilyGroupedSummary(products: ProductRecord[]): string {
  const familyGroups = new Map<string, ProductRecord[]>()

  // Group by family
  products.forEach(p => {
    const family = p.family || 'Unknown'
    if (!familyGroups.has(family)) {
      familyGroups.set(family, [])
    }
    familyGroups.get(family)!.push(p)
  })

  // Create summary with representatives from each family
  const summaries: string[] = []

  Array.from(familyGroups.entries())
    .sort((a, b) => b[1].length - a[1].length) // Sort by count
    .forEach(([family, prods]) => {
      summaries.push(`\n**${family}** (${prods.length} products):`)

      // Show up to 3 representatives per family
      const reps = prods.slice(0, 3)
      reps.forEach((p, i) => {
        summaries.push(`  ${i + 1}. ${p.Product_Type || 'N/A'} - ${p.Product_Model || 'N/A'} (SKU: ${p.sku || 'N/A'})`)
      })

      if (prods.length > 3) {
        summaries.push(`  ... and ${prods.length - 3} more`)
      }
    })

  return summaries.join('\n')
}

// Essential product data with dynamic fields
async function prepareEssentialProductData(products: ProductRecord[], maxProducts: number = MAX_DETAILED_PRODUCTS): Promise<string> {
  const allColumns = await getDatabaseColumns()

  const priorityFields = [
    'sku', 'family', 'Product_Name', 'Product_Type', 'Product_Model',
    'Product_Description', 'Application'
  ]

  const essentialFields = priorityFields.filter(field => allColumns.includes(field))
  const productsToSend = products.slice(0, maxProducts)

  return productsToSend.map((product, index) => {
    const lines: string[] = []
    lines.push(`\n${index + 1}. ${product.family || 'N/A'} | ${product.Product_Type || 'N/A'}`)

    essentialFields.forEach(field => {
      if (product[field] && field !== 'family' && field !== 'Product_Type') {
        const value = String(product[field]).substring(0, MAX_FIELD_LENGTH)
        lines.push(`   ${field}: ${value}`)
      }
    })

    return lines.join('\n')
  }).join('\n')
}

// ============================================================================
// AI ANSWER GENERATION
// ============================================================================

async function generateAIAnswer(
  userQuery: string,
  plan: AIQueryPlan,
  products: ProductRecord[]
): Promise<{ answer: string; shouldShowComparison: boolean; comparisonProducts?: ProductRecord[] }> {
  console.log(`🤖 AI generating answer for ${products.length} products`)

  if (products.length === 0) {
    return {
      answer: `No products found matching: "${userQuery}".\n\n**Suggestions:**\n- Try different keywords (e.g., "basecoat" instead of "base coat")\n- Check the Product Type filter options\n- Search for specific product families or SKUs\n- Try broader terms like "primer" or "topcoat"`,
      shouldShowComparison: false
    }
  }

  const shortSystemPrompt = `You are an aerospace coatings expert. Answer concisely using provided data.

Format: Use markdown, **bold** for key info, tables for comparisons, dashes (-) for lists.`

  try {
    const needsDetailedAnalysis = products.length > MAX_DETAILED_PRODUCTS

    if (needsDetailedAnalysis) {
      console.log(`⚡ DETAILED ANALYSIS approach (${products.length} products)`)

      // Group products by family, type, model
      const familyGroups = new Map<string, number>()
      const typeGroups = new Map<string, number>()
      const modelGroups = new Map<string, number>()

      products.forEach(p => {
        const family = p.family || 'Unknown'
        const type = p.Product_Type || 'Unknown'
        const model = p.Product_Model || 'Unknown'

        familyGroups.set(family, (familyGroups.get(family) || 0) + 1)
        typeGroups.set(type, (typeGroups.get(type) || 0) + 1)
        modelGroups.set(model, (modelGroups.get(model) || 0) + 1)
      })

      const familyStats = Array.from(familyGroups.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `- **${name}**: ${count} product${count > 1 ? 's' : ''}`)
        .join('\n')

      const familyGroupedDetails = createFamilyGroupedSummary(products)

      const typeStats = Array.from(typeGroups.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `- ${name}: ${count}`)
        .join('\n')

      console.log(`📊 Stage 1: Overview with statistics...`)

      const stage1Completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: shortSystemPrompt },
          {
            role: 'user',
            content: `Question: ${userQuery}

Total: **${products.length} products found**

**Complete Breakdown by Family (ALL ${familyGroups.size} families):**
${familyStats}

**Breakdown by Type:**
${typeStats}

**Representative Products by Family:**
${familyGroupedDetails}

Provide a comprehensive overview. List ALL ${familyGroups.size} product families found. Be specific and complete.`
          }
        ],
        temperature: 0.3,
        max_tokens: 1500
      })

      const stage1Answer = stage1Completion.choices[0].message.content || ''
      console.log(`✅ Stage 1 complete (${stage1Answer.length} chars)`)

      // Stage 2: Detailed examples
      const topProducts = products.slice(0, MAX_DETAILED_PRODUCTS)
      const essentialData = await prepareEssentialProductData(topProducts, MAX_DETAILED_PRODUCTS)

      console.log(`📊 Stage 2: Detailed examples (${topProducts.length} products)...`)

      const stage2Completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: shortSystemPrompt + '\n\nBe concise but comprehensive. Use tables where possible.' },
          {
            role: 'user',
            content: `Question: ${userQuery}

Representative products (${topProducts.length} of ${products.length} total):
${essentialData}

Create a detailed comparison table showing key specs. Group by family if helpful. Be comprehensive but concise.`
          }
        ],
        temperature: 0.3,
        max_tokens: 2500
      })

      const stage2Answer = stage2Completion.choices[0].message.content || ''
      console.log(`✅ Stage 2 complete (${stage2Answer.length} chars)`)

      // Create full product list table
      const productListTable = createProductListTable(products)

      // Combine everything
      const combinedAnswer = `${stage1Answer}

---

## Representative Products (Detailed)

${stage2Answer}

---

## Complete Product List (All ${products.length} Products)

${productListTable}

---

**Note:** The table above shows all ${products.length} products found. The detailed analysis covers the top ${topProducts.length} representative products.`

      const shouldShowComparison = plan.intent === 'comparison' && topProducts.length >= 2 && topProducts.length <= 10

      return {
        answer: combinedAnswer,
        shouldShowComparison,
        comparisonProducts: shouldShowComparison ? topProducts : undefined
      }

    } else {
      // Single-stage for small datasets
      console.log(`⚡ SINGLE-STAGE approach (${products.length} products)`)

      const essentialData = await prepareEssentialProductData(products)

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: shortSystemPrompt },
          {
            role: 'user',
            content: `Question: ${userQuery}

Products (${products.length} total):
${essentialData}

Answer comprehensively but concisely. Include all products.`
          }
        ],
        temperature: 0.3,
        max_tokens: 2000
      })

      const answer = completion.choices[0].message.content || 'Unable to generate answer.'
      console.log(`✅ AI answer generated (${answer.length} chars)`)

      // Add full product list table
      const productListTable = createProductListTable(products)
      const finalAnswer = `${answer}

---

## Complete Product List (All ${products.length} Products)

${productListTable}`

      const shouldShowComparison = plan.intent === 'comparison' && products.length >= 2 && products.length <= 10

      return {
        answer: finalAnswer,
        shouldShowComparison,
        comparisonProducts: shouldShowComparison ? products.slice(0, 10) : undefined
      }
    }

  } catch (error: any) {
    console.error('❌ AI answer generation failed:', error)

    // Fallback: Return product list with basic stats
    const familyCounts = new Map<string, number>()
    products.forEach(p => {
      const family = p.family || 'Unknown'
      familyCounts.set(family, (familyCounts.get(family) || 0) + 1)
    })

    const familyList = Array.from(familyCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([family, count]) => `- ${family}: ${count} product${count > 1 ? 's' : ''}`)
      .join('\n')

    const productListTable = createProductListTable(products)

    return {
      answer: `## Search Results

Found **${products.length} products** matching your query.

### By Family:
${familyList}

---

## Complete Product List (All ${products.length} Products)

${productListTable}

---

*Note: Detailed analysis unavailable. All products are listed in the table above.*`,
      shouldShowComparison: false
    }
  }
}

// ============================================================================
// MAIN API HANDLER
// ============================================================================

export async function POST(req: NextRequest) {
  const startTime = Date.now()

  try {
    const body = await req.json()
    const { query, family = '', productType = '', productModel = '', forceRefresh = false } = body

    if (query === '__GET_FILTER_OPTIONS__') {
      console.log(`\n${'='.repeat(80)}`)
      console.log(`> 🎛️ Internal request: GET_FILTER_OPTIONS`)
      const filterOptions = await getFilterOptions(forceRefresh)
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
      console.log(`${'='.repeat(80)}\n`)
      return NextResponse.json(filterOptions)
    }

    console.log(`\n${'='.repeat(80)}`)
    console.log(`> 🔍 User query: ${query}`)
    console.log(`> 🎯 Applied filters: { family: '${family}', productType: '${productType}', productModel: '${productModel}' }`)

    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Invalid query parameter' },
        { status: 400 }
      )
    }

    const appliedFilters = { family, productType, productModel }
    const plan = await planQuery(query, appliedFilters)

    console.log(`> 🎯 AI determined intent: ${plan.intent}`)
    console.log(`> 🔑 Search terms: ${plan.searchTerms.join(', ')}`)

    const searchResults = await executeSmartSearch(plan, appliedFilters)
    console.log(`> ✅ Found ${searchResults.length} products`)

    const cleanedProducts = searchResults.map(p => cleanProductData(p))

    const { answer, shouldShowComparison, comparisonProducts } = await generateAIAnswer(
      query,
      plan,
      cleanedProducts
    )

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
    console.log(`${'='.repeat(80)}\n`)

    // 🎯 FIX: Check for embedding column availability
    const dbColumns = await getDatabaseColumns()
    const hasEmbeddings = dbColumns.includes('embedding')

    return NextResponse.json({
      success: true,
      intent: plan.intent,
      summary: answer,
      products: cleanedProducts,
      count: cleanedProducts.length,
      showComparison: shouldShowComparison,
      message: `Found ${cleanedProducts.length} product(s)`,
      aiExplanation: plan.explanation,
      usedTwoStage: cleanedProducts.length > MAX_DETAILED_PRODUCTS,
      searchStrategies: {
        skuMatch: detectSKUs(plan.searchTerms).length > 0,
        semanticSearch: hasEmbeddings,  // ✅ FIXED
        keywordSearch: true
      }
    })

  } catch (error: any) {
    console.error('> ❌ Search error:', error)
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(` POST /api/coatings-smart-search 500 in ${duration}s`)
    console.log(`${'='.repeat(80)}\n`)

    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Internal server error',
        details: error.toString()
      },
      { status: 500 }
    )
  }
}

